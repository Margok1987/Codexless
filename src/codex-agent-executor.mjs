import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { CodexAppServerClient, CodexRpcError } from "./codex-app-server-client.mjs";
import { buildAgentResourceReceipt } from "./agent-resource.mjs";
import { computeCodexAuthorityPolicyHash } from "./codex-authority-executor.mjs";
import { projectCodexModel } from "./codex-model-catalog.mjs";

const TERMINAL_TURN_STATUSES = new Set(["completed", "failed", "interrupted"]);
const FOLLOW_UP_PARENT_STATUSES = new Set(["completed", "interrupted"]);
const DEFAULT_MAX_EVENTS = 128;
const MAX_EVENT_TEXT_CHARS = 2_048;
const MAX_PROGRESS_MESSAGE_CHARS = 8_192;
const MAX_PROGRESS_PLAN_STEPS = 64;
const MAX_PROGRESS_STEP_CHARS = 2_048;

function boundedProgressText(value, maxChars = MAX_PROGRESS_MESSAGE_CHARS) {
  if (typeof value !== "string") return { text: "", truncated: false };
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: value.slice(-maxChars), truncated: true };
}

function boundedPlan(params) {
  if (!params || typeof params !== "object") return null;
  const rawPlan = Array.isArray(params.plan) ? params.plan : [];
  const plan = rawPlan.slice(0, MAX_PROGRESS_PLAN_STEPS).map((entry) => ({
    step: typeof entry?.step === "string" ? entry.step.slice(0, MAX_PROGRESS_STEP_CHARS) : "",
    status: typeof entry?.status === "string" ? entry.status : null,
  }));
  return {
    explanation: typeof params.explanation === "string"
      ? params.explanation.slice(0, MAX_PROGRESS_MESSAGE_CHARS)
      : null,
    plan,
    truncated: rawPlan.length > plan.length,
    updatedAt: Date.now(),
  };
}

function compactActiveItem(item) {
  if (!item || typeof item !== "object") return null;
  return {
    id: typeof item.id === "string" ? item.id : null,
    type: typeof item.type === "string" ? item.type : "unknown",
    status: typeof item.status === "string" ? item.status : "inProgress",
    updatedAt: Date.now(),
  };
}

function hashRequest(
  cwd,
  task,
  model = null,
  reasoningEffort = null,
  permissionProfile = null,
  permissionCeiling = null,
  authorityPolicyHash = null
) {
  const material = [
    cwd,
    task,
    model ?? "",
    reasoningEffort ?? "",
    permissionProfile ?? "",
    permissionCeiling ?? "",
    authorityPolicyHash ?? "",
  ];
  return createHash("sha256").update(JSON.stringify(material), "utf8").digest("hex");
}

function normalizeModel(model) {
  if (model === null || model === undefined) return null;
  if (typeof model !== "string" || !model.trim()) throw new Error("model must be a non-empty string when provided");
  return model.trim();
}

function normalizeReasoningEffort(reasoningEffort) {
  if (reasoningEffort === null || reasoningEffort === undefined) return null;
  if (typeof reasoningEffort !== "string" || !reasoningEffort.trim()) {
    throw new Error("reasoningEffort must be a non-empty string when provided");
  }
  const normalized = reasoningEffort.trim();
  if (normalized.length > 128) throw new Error("reasoningEffort must be at most 128 characters");
  return normalized;
}

function modelIdentity(entry) {
  return typeof entry?.model === "string" && entry.model
    ? entry.model
    : typeof entry?.id === "string" && entry.id
      ? entry.id
      : null;
}

function supportedReasoningEfforts(entry) {
  return Array.isArray(entry?.supportedReasoningEfforts)
    ? entry.supportedReasoningEfforts
        .map((option) => typeof option?.reasoningEffort === "string" ? option.reasoningEffort : null)
        .filter(Boolean)
    : [];
}

function normalizeAgentStatus(turnStatus) {
  if (turnStatus === "inProgress" || turnStatus === "running") return "running";
  if (turnStatus === "completed") return "idle";
  if (turnStatus === "failed") return "failed";
  if (turnStatus === "interrupted") return "interrupted";
  return "unknown";
}

function lastAgentMessage(turn) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type === "agentMessage" && typeof item.text === "string") return item.text;
  }
  return null;
}

function notificationThreadId(message) {
  return message?.params?.threadId ?? message?.params?.thread?.id ?? null;
}

function notificationTurn(message) {
  return message?.params?.turn ?? null;
}

function notificationTurnId(message) {
  return message?.params?.turnId ?? notificationTurn(message)?.id ?? null;
}

function notificationRequestId(message) {
  return message?.params?.requestId ?? null;
}

function controlRequestHash(action, agentRef, targetId) {
  return createHash("sha256").update(JSON.stringify({ action, agentRef, targetId }), "utf8").digest("hex");
}

function steerRequestHash(agentRef, targetTurnId, message) {
  return createHash("sha256")
    .update(`steer\0${agentRef}\0${targetTurnId ?? ""}\0${message}`, "utf8")
    .digest("hex");
}

function approvalResponseFor(handle, decision) {
  const params = handle?.params && typeof handle.params === "object" ? handle.params : {};
  if (handle?.method === "item/commandExecution/requestApproval") {
    const wanted = decision === "approve" ? "accept" : "decline";
    if (Array.isArray(params.availableDecisions) && !params.availableDecisions.some((entry) => entry === wanted)) {
      throw new Error(`Codex approval does not offer ${wanted} for this command request`);
    }
    return { decision: wanted };
  }
  if (handle?.method === "item/fileChange/requestApproval") {
    return { decision: decision === "approve" ? "accept" : "decline" };
  }
  if (handle?.method === "item/permissions/requestApproval") {
    return {
      permissions: decision === "approve" ? structuredClone(params.permissions ?? {}) : {},
      scope: "turn",
      strictAutoReview: false,
    };
  }
  throw new Error(`unsupported Codex approval request method: ${String(handle?.method ?? "unknown")}`);
}

function boundedApprovalValue(value, maxChars = 16_384) {
  if (value === undefined || value === null) return null;
  try {
    const text = JSON.stringify(value);
    if (text.length <= maxChars) return structuredClone(value);
    return { truncated: true, preview: text.slice(0, maxChars) };
  } catch {
    return null;
  }
}

function approvalDetails(request, item = null) {
  const params = request?.params && typeof request.params === "object" ? request.params : {};
  if (request?.method === "item/commandExecution/requestApproval") {
    return {
      kind: "command",
      command: typeof params.command === "string" ? params.command.slice(0, 16_384) : null,
      cwd: typeof params.cwd === "string" ? params.cwd.slice(0, 32_768) : null,
      commandActions: boundedApprovalValue(params.commandActions ?? item?.commandActions ?? null),
      networkApprovalContext: boundedApprovalValue(params.networkApprovalContext ?? null),
      additionalPermissions: boundedApprovalValue(params.additionalPermissions ?? null),
    };
  }
  if (request?.method === "item/fileChange/requestApproval") {
    return {
      kind: "fileChange",
      grantRoot: typeof params.grantRoot === "string" ? params.grantRoot.slice(0, 32_768) : null,
      changes: boundedApprovalValue(item?.changes ?? null),
    };
  }
  if (request?.method === "item/permissions/requestApproval") {
    return {
      kind: "permissions",
      cwd: typeof params.cwd === "string" ? params.cwd.slice(0, 32_768) : null,
      permissions: boundedApprovalValue(params.permissions ?? {}),
    };
  }
  const humanText = [params.message, params.reason, params.prompt, params.title, params.description]
    .find((value) => typeof value === "string" && value.trim());
  return {
    kind: "unknown",
    humanText: humanText ? humanText.trim().slice(0, 16_384) : null,
    schema: boundedApprovalValue(params.schema ?? params.requestSchema ?? params.inputSchema ?? null),
    availableDecisions: boundedApprovalValue(params.availableDecisions ?? null),
  };
}

function approvalSummary(request, item = null) {
  const params = request?.params && typeof request.params === "object" ? request.params : {};
  const summary = {
    requestId: request.id,
    method: request.method,
    threadId: params.threadId ?? null,
    turnId: params.turnId ?? null,
    itemId: params.itemId ?? params.item?.id ?? null,
    receivedAt: Date.now(),
    details: approvalDetails(request, item),
  };
  if (typeof params.reason === "string") summary.reason = params.reason.slice(0, MAX_EVENT_TEXT_CHARS);
  return summary;
}

function compactNotification(message) {
  const event = { type: message.method, at: Date.now() };
  const turnId = notificationTurnId(message);
  if (turnId) event.turnId = turnId;

  if (message.method === "item/agentMessage/delta") {
    const delta = message?.params?.delta;
    if (typeof delta === "string") event.text = delta.slice(-MAX_EVENT_TEXT_CHARS);
  }
  if (message.method === "item/mcpToolCall/progress") {
    const messageText = message?.params?.message;
    if (typeof messageText === "string") event.text = messageText.slice(-MAX_EVENT_TEXT_CHARS);
  }
  if (message.method === "thread/tokenUsage/updated" && message?.params?.tokenUsage) {
    event.tokenUsage = message.params.tokenUsage;
  }
  return event;
}

export class CodexAgentExecutor {
  #client;
  #defaultCwd;
  #agents = new Map();
  #clientRequestIds = new Map();
  #startOperations = new Map();
  #sendRequestIds = new Map();
  #sendOperations = new Map();
  #activeSendByAgent = new Map();
  #controlRequestIds = new Map();
  #unsubscribe = null;
  #opened = false;
  #closed = false;
  #openPromise = null;
  #closePromise = null;
  #clientClosePromise = null;
  #shutdownError = null;
  #operations = new Set();
  #maxEvents;
  #nextEventSeq = 1;
  #resourceSnapshotProvider;
  #admissionCheck;
  #cleanupFailureHandler;
  #cleanupFailureReported = false;
  #requireAuthorityPolicy;
  #requireChatgptAuth;
  #maxAgents;
  #maxRequestBindings;
  #maxControlBindings;
  #maxInFlight;
  #pendingStarts = 0;
  #preTurnCleanupFailed = false;

  constructor({
    codexBin = null,
    defaultCwd,
    configOverrides = [],
    launchEnv = null,
    requestTimeoutMs = 30_000,
    maxEvents = DEFAULT_MAX_EVENTS,
    clientFactory = null,
    resourceSnapshotProvider = null,
    admissionCheck = null,
    cleanupFailureHandler = null,
    requireAuthorityPolicy = false,
    requireChatgptAuth = false,
    maxAgents = 1_000,
    maxRequestBindings = 10_000,
    maxControlBindings = 10_000,
    maxInFlight = 128,
  }) {
    if (!defaultCwd) throw new Error("CodexAgentExecutor requires defaultCwd");
    if (!Number.isInteger(maxEvents) || maxEvents < 1) throw new Error("maxEvents must be a positive integer");
    if (!Array.isArray(configOverrides) || !configOverrides.every((value) => typeof value === "string" && value.trim())) {
      throw new Error("configOverrides must be an array of non-empty Codex -c key=value strings");
    }
    if (!clientFactory && !codexBin) throw new Error("CodexAgentExecutor requires codexBin or clientFactory");
    if (launchEnv !== null && (typeof launchEnv !== "object" || Array.isArray(launchEnv))) {
      throw new Error("launchEnv must be null or an environment object");
    }
    if (resourceSnapshotProvider !== null && typeof resourceSnapshotProvider !== "function") {
      throw new Error("resourceSnapshotProvider must be a function when provided");
    }
    if (admissionCheck !== null && typeof admissionCheck !== "function") {
      throw new Error("admissionCheck must be a function when provided");
    }
    if (cleanupFailureHandler !== null && typeof cleanupFailureHandler !== "function") {
      throw new Error("cleanupFailureHandler must be a function when provided");
    }

    if (typeof requireAuthorityPolicy !== "boolean" || typeof requireChatgptAuth !== "boolean") {
      throw new Error("Account authority/authentication requirements must be boolean");
    }
    for (const [name, value] of Object.entries({ maxAgents, maxRequestBindings, maxControlBindings, maxInFlight })) {
      if (!Number.isInteger(value) || value < 1 || value > 100_000) throw new Error(`${name} must be 1..100000`);
    }
    this.#defaultCwd = path.resolve(defaultCwd);
    this.#maxEvents = maxEvents;
    this.#resourceSnapshotProvider = resourceSnapshotProvider;
    this.#admissionCheck = admissionCheck;
    this.#cleanupFailureHandler = cleanupFailureHandler;
    this.#requireAuthorityPolicy = requireAuthorityPolicy;
    this.#requireChatgptAuth = requireChatgptAuth;
    this.#maxAgents = maxAgents;
    this.#maxRequestBindings = maxRequestBindings;
    this.#maxControlBindings = maxControlBindings;
    this.#maxInFlight = maxInFlight;
    const serverRequestHandler = (request) => this.#onServerRequest(request);
    this.#client = clientFactory
      ? clientFactory({ cwd: this.#defaultCwd, requestTimeoutMs, serverRequestHandler, launchEnv, cleanupFailureHandler: (error) => this.#reportCleanupFailure(error) })
      : new CodexAppServerClient({
          cwd: this.#defaultCwd,
          launch: () => ({
            command: codexBin,
            args: [
              ...configOverrides.flatMap((value) => ["-c", value]),
              "app-server",
              "--stdio",
            ],
            options: { cwd: this.#defaultCwd, ...(launchEnv ? { env: launchEnv } : {}) },
          }),
          requestTimeoutMs,
          initializeCapabilities: { experimentalApi: true },
          serverRequestHandler,
          cleanupFailureHandler: (error) => this.#reportCleanupFailure(error),
          clientInfo: {
            name: "codexless_agent",
            title: "Codexless Agent",
            version: "0.1.50-household-workspace",
          },
        });
  }

  get running() {
    return this.#opened && !this.#closed && this.#client.running;
  }

  async open() {
    if (this.#closed) throw new Error("CodexAgentExecutor is closed");
    if (this.#opened) return this.#client.initializedResult;
    if (this.#openPromise) return this.#openPromise;
    const opening = (async () => {
      try {
        const initialized = await this.#client.start();
        if (this.#closed) throw new Error("CodexAgentExecutor closed while opening");
        this.#unsubscribe = this.#client.onNotification((message) => this.#onNotification(message));
        this.#opened = true;
        return initialized;
      } catch (error) {
        try { await this.#closeClient(); }
        catch (cleanupError) { this.#shutdownError = cleanupError; }
        throw error;
      }
    })();
    this.#openPromise = opening;
    try { return await opening; }
    finally { if (this.#openPromise === opening) this.#openPromise = null; }
  }

  async close() {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    try { this.#unsubscribe?.(); }
    catch (error) { this.#shutdownError = error; }
    this.#unsubscribe = null;
    this.#closePromise = (async () => {
      const results = await Promise.allSettled([this.#closeClient(), this.#openPromise, ...this.#operations]);
      this.#opened = false;
      this.#agents.clear();
      this.#clientRequestIds.clear();
      this.#startOperations.clear();
      this.#sendRequestIds.clear();
      this.#sendOperations.clear();
      this.#activeSendByAgent.clear();
      this.#controlRequestIds.clear();
      this.#operations.clear();
      if (results[0].status === "rejected") throw results[0].reason;
      if (this.#shutdownError) throw this.#shutdownError;
    })();
    return this.#closePromise;
  }

  #reportCleanupFailure(error) {
    if (this.#cleanupFailureReported) return;
    this.#cleanupFailureReported = true;
    this.#shutdownError = error;
    try { this.#cleanupFailureHandler?.(); } catch {}
  }

  #assertTurnAdmission() {
    if (this.#preTurnCleanupFailed) {
      throw Object.assign(new Error("Account thread cleanup failed; new turns are blocked until controlled shutdown"), { code: "CODEX_AGENT_CLEANUP_FAILED" });
    }
    this.#admissionCheck?.();
  }

  async #closeClient() {
    if (this.#clientClosePromise) return this.#clientClosePromise;
    const closing = Promise.resolve().then(() => this.#client.close());
    this.#clientClosePromise = closing;
    try { return await closing; }
    catch (error) { this.#reportCleanupFailure(error); throw error; }
    finally { if (this.#clientClosePromise === closing) this.#clientClosePromise = null; }
  }

  async #listModels({ cursor = null, limit = null, includeHidden = false } = {}) {
    this.#assertOpen();
    if (cursor !== null && (typeof cursor !== "string" || !cursor)) throw new Error("cursor must be a non-empty string when provided");
    if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 200)) throw new Error("limit must be an integer from 1 to 200 when provided");
    if (typeof includeHidden !== "boolean") throw new Error("includeHidden must be a boolean");
    const result = await this.#request("model/list", {
      ...(cursor ? { cursor } : {}),
      ...(limit ? { limit } : {}),
      includeHidden,
    });
    return {
      models: Array.isArray(result?.data) ? result.data.map(projectCodexModel).filter(Boolean) : [],
      nextCursor: typeof result?.nextCursor === "string" ? result.nextCursor : null,
    };
  }

  async #start({
    cwd = this.#defaultCwd,
    task,
    clientRequestId = null,
    permissionProfile = null,
    permissionCeiling = null,
    authorityPolicyHash = null,
    model = null,
    reasoningEffort = null,
  }) {
    this.#assertOpen();
    if (typeof task !== "string" || !task.trim()) throw new Error("task must be a non-empty string");
    if (clientRequestId !== null && (typeof clientRequestId !== "string" || !clientRequestId.trim())) {
      throw new Error("clientRequestId must be a non-empty string when provided");
    }
    if (permissionProfile !== null && (typeof permissionProfile !== "string" || !permissionProfile.trim())) {
      throw new Error("permissionProfile must be a non-empty string when provided");
    }
    if (permissionCeiling !== null && (typeof permissionCeiling !== "string" || !permissionCeiling.trim())) {
      throw new Error("permissionCeiling must be a non-empty string when provided");
    }
    if (authorityPolicyHash !== null && !/^[0-9a-f]{64}$/i.test(authorityPolicyHash)) {
      throw new Error("authorityPolicyHash must be a SHA-256 hex string when provided");
    }
    if (authorityPolicyHash && (!permissionProfile || !permissionCeiling)) {
      throw new Error("authorityPolicyHash requires permissionProfile and permissionCeiling");
    }
    if (this.#requireAuthorityPolicy && !authorityPolicyHash) {
      throw Object.assign(new Error("CODEX_AGENT_AUTHORITY_MISMATCH: account execution requires a prepared authority policy"), { code: "CODEX_AGENT_AUTHORITY_MISMATCH" });
    }
    if (this.#preTurnCleanupFailed) {
      throw Object.assign(new Error("Account thread cleanup failed; new starts are blocked until controlled shutdown"), { code: "CODEX_AGENT_CLEANUP_FAILED" });
    }
    const requestedModel = normalizeModel(model);
    const requestedReasoningEffort = normalizeReasoningEffort(reasoningEffort);

    const effectiveCwd = path.resolve(cwd);
    const requestHash = hashRequest(
      effectiveCwd,
      task,
      requestedModel,
      requestedReasoningEffort,
      permissionProfile,
      permissionCeiling,
      authorityPolicyHash
    );
    let startOperation = null;
    if (clientRequestId) {
      const pending = this.#startOperations.get(clientRequestId);
      if (pending) {
        if (pending.requestHash !== requestHash) {
          throw new Error(`clientRequestId was already used for a different agent start: ${clientRequestId}`);
        }
        return { ...(await pending.promise), duplicate: true };
      }
      const prior = this.#clientRequestIds.get(clientRequestId);
      if (prior) {
        if (prior.requestHash !== requestHash) {
          throw new Error(`clientRequestId was already used for a different agent start: ${clientRequestId}`);
        }
        const state = this.#agents.get(prior.agentRef);
        if (!state) return this.#unknown(prior.agentRef, "accepted start mapping is no longer available");
        return { ...this.#snapshot(state, 0), duplicate: true };
      }
      let resolveOperation;
      let rejectOperation;
      const promise = new Promise((resolve, reject) => {
        resolveOperation = resolve;
        rejectOperation = reject;
      });
      promise.catch(() => {});
      startOperation = { requestHash, promise, resolve: resolveOperation, reject: rejectOperation };
      this.#startOperations.set(clientRequestId, startOperation);
    }
    const settleStartOperation = (kind, value) => {
      if (!startOperation || !clientRequestId) return;
      if (this.#startOperations.get(clientRequestId) === startOperation) {
        this.#startOperations.delete(clientRequestId);
      }
      if (kind === "resolve") startOperation.resolve(value);
      else startOperation.reject(value);
    };

    if (this.#agents.size + this.#pendingStarts >= this.#maxAgents) {
      const error = Object.assign(new Error("Agent capacity reached; new starts are blocked without forgetting existing agents or replay bindings"), { code: "CODEX_AGENT_CAPACITY" });
      settleStartOperation("reject", error);
      throw error;
    }
    this.#pendingStarts += 1;
    let validatedReasoningModel = null;
    try {
      if (requestedReasoningEffort) {
        const validation = await this.#validateReasoningEffort({
          requestedModel,
          currentModel: null,
          requestedReasoningEffort,
        });
        validatedReasoningModel = validation.effectiveModel;
      }
    } catch (error) {
      this.#pendingStarts -= 1;
      settleStartOperation("reject", error);
      throw error;
    }

    // From here through #agents.set there is no await, so capacity ownership
    // transfers atomically from the pending counter to the live agent map.
    this.#pendingStarts -= 1;
    const agentRef = `agent_${randomUUID()}`;
    const state = {
      agentRef,
      cwd: effectiveCwd,
      threadId: null,
      currentTurnId: null,
      status: "starting",
      latestTurnStatus: null,
      finalResult: null,
      latestError: null,
      pendingApproval: null,
      pendingRequestHandle: null,
      approvalItems: new Map(),
      latestTokenUsage: null,
      progressPlan: null,
      progressAgentMessage: null,
      progressActiveItem: null,
      resourceReceipt: null,
      resourceReceiptTurnId: null,
      resourceReceiptPromise: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      turnStartedAt: null,
      turnEndedAt: null,
      turnDurationMs: null,
      lastCompletedTurnId: null,
      permissionProfile,
      permissionCeiling,
      authorityPolicyHash,
      requestedModel,
      requestedReasoningEffort,
      resolvedModel: null,
      modelProvider: null,
      serviceTier: null,
      reasoningEffort: null,
      events: [],
    };
    this.#agents.set(agentRef, state);
    if (clientRequestId) this.#clientRequestIds.set(clientRequestId, { agentRef, requestHash });

    try {
      const threadParams = {
        cwd: effectiveCwd,
        ephemeral: false,
      };
      if (permissionProfile) threadParams.permissions = permissionProfile;
      if (requestedModel || validatedReasoningModel) threadParams.model = requestedModel ?? validatedReasoningModel;
      // Current App Server v2 does not accept reasoningEffort as a top-level
      // thread/start parameter. Bind the approved effort through the supported
      // per-thread config override so thread/start can resolve and echo the
      // effective effort before any metered turn is dispatched.
      if (requestedReasoningEffort) {
        threadParams.config = { model_reasoning_effort: requestedReasoningEffort };
      }
      const started = await this.#request("thread/start", threadParams);
      const threadId = started?.thread?.id;
      if (typeof threadId !== "string" || !threadId) throw new Error("thread/start returned no formal thread id");
      state.threadId = threadId;
      if (permissionProfile) {
        const activeProfile = started?.activePermissionProfile?.id;
        if (activeProfile !== permissionProfile) {
          throw new Error(
            `thread/start authority mismatch: expected ${permissionProfile}, got ${String(activeProfile ?? "missing")}`
          );
        }
      }
      await this.#assertBoundAuthority(state, started);
      await this.#assertChatgptAuth();
      const expectedModel = requestedModel ?? validatedReasoningModel;
      const acceptedModel = typeof started?.model === "string" ? started.model : null;
      if (expectedModel && acceptedModel !== expectedModel) {
        throw new Error(
          `CODEX_AGENT_SELECTION_MISMATCH: prepared model "${expectedModel}" was not honored by thread/start (observed ${acceptedModel ?? "missing"}); no Codex turn was started`
        );
      }
      const acceptedReasoningEffort = typeof started?.reasoningEffort === "string" ? started.reasoningEffort : null;
      if (requestedReasoningEffort && acceptedReasoningEffort !== requestedReasoningEffort) {
        throw new Error(
          `CODEX_AGENT_SELECTION_MISMATCH: prepared reasoning effort "${requestedReasoningEffort}" was not honored by thread/start (observed ${acceptedReasoningEffort ?? "missing"}); no Codex turn was started`
        );
      }
      state.threadId = threadId;
      state.status = "idle";
      state.resolvedModel = acceptedModel ?? requestedModel;
      state.modelProvider = typeof started?.modelProvider === "string" ? started.modelProvider : null;
      state.serviceTier = typeof started?.serviceTier === "string" ? started.serviceTier : null;
      state.reasoningEffort = acceptedReasoningEffort;
      state.updatedAt = Date.now();
      this.#appendEvent(state, { type: "thread/accepted", threadId, model: state.resolvedModel, at: Date.now() });
      this.#assertTurnAdmission();
    } catch (error) {
      let failure = error;
      if (state.threadId && !this.#closed) {
        try { await this.#request("thread/delete", { threadId: state.threadId }); }
        catch {
          this.#preTurnCleanupFailed = true;
          failure = Object.assign(new Error("CODEX_AGENT_CLEANUP_FAILED: rejected pre-turn thread could not be deleted; no model turn was started and new starts are blocked"), { code: "CODEX_AGENT_CLEANUP_FAILED" });
          this.#reportCleanupFailure(failure);
        }
      }
      this.#agents.delete(agentRef);
      if (clientRequestId) this.#clientRequestIds.delete(clientRequestId);
      settleStartOperation("reject", failure);
      throw failure;
    }

    try {
      state.turnStartedAt = Date.now();
      state.turnEndedAt = null;
      state.turnDurationMs = null;
      const turnStarted = await this.#request("turn/start", {
        threadId: state.threadId,
        clientUserMessageId: clientRequestId ?? agentRef,
        input: [{ type: "text", text: task }],
        // thread/start establishes the thread default; mirror the same explicit
        // request onto the first turn so turn/start cannot silently diverge.
        ...(requestedReasoningEffort ? { effort: requestedReasoningEffort } : {}),
      });
      const turn = turnStarted?.turn;
      if (typeof turn?.id !== "string" || !turn.id) throw new Error("turn/start returned no turn id");
      state.currentTurnId = turn.id;
      state.latestTurnStatus = turn.status ?? "inProgress";
      state.status = state.pendingApproval ? "awaitingApproval" : normalizeAgentStatus(state.latestTurnStatus);
      if (state.status === "unknown") state.status = "running";
      state.updatedAt = Date.now();
      this.#appendEvent(state, { type: "turn/accepted", turnId: turn.id, status: turn.status ?? null, at: Date.now() });
      const result = { ...this.#snapshot(state, 0), duplicate: false };
      settleStartOperation("resolve", result);
      return result;
    } catch (error) {
      state.latestError = error instanceof Error ? error.message : String(error);
      if (state.pendingApproval) {
        if (!state.currentTurnId && state.pendingApproval.turnId) state.currentTurnId = state.pendingApproval.turnId;
        if (!state.latestTurnStatus) state.latestTurnStatus = "inProgress";
        state.status = "awaitingApproval";
      } else {
        state.status = "unknown";
      }
      state.updatedAt = Date.now();
      this.#appendEvent(state, { type: "turn/acceptance-unknown", text: state.latestError, at: Date.now() });
      const result = { ...this.#snapshot(state, 0), duplicate: false };
      settleStartOperation("resolve", result);
      return result;
    }
  }

  async #show({ agentRef, afterSeq = 0 }) {
    this.#assertOpen();
    if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new Error("afterSeq must be a non-negative integer");
    const state = this.#agents.get(agentRef);
    if (!state) return this.#unknown(agentRef, "unknown agentRef");
    await this.#refreshFromOfficial(state);
    await this.#ensureResourceReceipt(state);
    return this.#snapshot(state, afterSeq);
  }

  async #resolvePendingRequest({ agentRef, requestId, result }, safetyRejection = false) {
    this.#assertOpen();
    const state = this.#agents.get(agentRef);
    if (!state) throw new Error(`unknown agentRef: ${agentRef}`);
    if (!state.pendingApproval || !state.pendingRequestHandle) {
      throw new Error(`agent has no pending server request: ${agentRef}`);
    }
    if (String(state.pendingApproval.requestId) !== String(requestId)) {
      throw new Error(`server request is unknown or stale for agent ${agentRef}: ${String(requestId)}`);
    }
    if (!safetyRejection) this.#assertTurnAdmission();
    state.pendingRequestHandle.resolve(result);
    const resolvedId = state.pendingApproval.requestId;
    state.pendingApproval = null;
    state.pendingRequestHandle = null;
    state.status = normalizeAgentStatus(state.latestTurnStatus);
    if (state.status === "unknown") state.status = "running";
    state.updatedAt = Date.now();
    this.#appendEvent(state, { type: "server-request/resolved-local", requestId: resolvedId, at: Date.now() });
    return this.#snapshot(state, 0);
  }

  async #rejectPendingRequest({ agentRef, requestId, error }) {
    this.#assertOpen();
    const state = this.#agents.get(agentRef);
    if (!state) throw new Error(`unknown agentRef: ${agentRef}`);
    if (!state.pendingApproval || !state.pendingRequestHandle) {
      throw new Error(`agent has no pending server request: ${agentRef}`);
    }
    if (String(state.pendingApproval.requestId) !== String(requestId)) {
      throw new Error(`server request is unknown or stale for agent ${agentRef}: ${String(requestId)}`);
    }
    state.pendingRequestHandle.reject(error);
    const rejectedId = state.pendingApproval.requestId;
    state.pendingApproval = null;
    state.pendingRequestHandle = null;
    state.status = normalizeAgentStatus(state.latestTurnStatus);
    if (state.status === "unknown") state.status = "running";
    state.updatedAt = Date.now();
    this.#appendEvent(state, { type: "server-request/rejected-local", requestId: rejectedId, at: Date.now() });
    return this.#snapshot(state, 0);
  }

  async #resolveApproval({ agentRef, approvalRequestId, clientRequestId, decision }) {
    this.#assertOpen();
    if (!new Set(["approve", "reject"]).has(decision)) throw new Error("decision must be approve or reject");
    if (typeof approvalRequestId !== "string" || !approvalRequestId.trim()) {
      throw new Error("approvalRequestId must be a non-empty string");
    }
    if (typeof clientRequestId !== "string" || !clientRequestId.trim()) {
      throw new Error("clientRequestId must be a non-empty string");
    }
    const hash = controlRequestHash(decision, agentRef, approvalRequestId);
    const prior = this.#controlRequestIds.get(clientRequestId);
    if (prior) {
      if (prior.requestHash !== hash) {
        throw new Error(`clientRequestId was already used for a different agent control action: ${clientRequestId}`);
      }
      const priorState = this.#agents.get(prior.agentRef);
      if (!priorState) return { ...this.#unknown(prior.agentRef, "accepted control mapping is no longer available"), duplicate: true };
      return { ...this.#snapshot(priorState, 0), duplicate: true };
    }
    this.#assertControlCapacity(decision === "reject");

    const state = this.#agents.get(agentRef);
    if (!state) return this.#unknown(agentRef, "unknown agentRef");
    if (!state.pendingApproval || !state.pendingRequestHandle) {
      throw new Error(`agent has no pending Codex approval: ${agentRef}`);
    }
    if (String(state.pendingApproval.requestId) !== approvalRequestId) {
      throw new Error(`approval request is unknown or stale for agent ${agentRef}: ${approvalRequestId}`);
    }

    const result = approvalResponseFor(state.pendingRequestHandle, decision);
    const snapshot = await this.#resolvePendingRequest({ agentRef, requestId: approvalRequestId, result }, decision === "reject");
    this.#controlRequestIds.set(clientRequestId, { agentRef, requestHash: hash });
    return { ...snapshot, duplicate: false };
  }

  async #steer({ agentRef, message, clientRequestId, expectedTurnId }) {
    this.#assertOpen();
    if (typeof message !== "string" || !message.trim()) throw new Error("message must be a non-empty string");
    if (typeof clientRequestId !== "string" || !clientRequestId.trim()) {
      throw new Error("clientRequestId must be a non-empty string");
    }
    if (typeof expectedTurnId !== "string" || !expectedTurnId.trim()) {
      throw new Error("expectedTurnId must be a non-empty string");
    }

    const state = this.#agents.get(agentRef);
    if (!state) return this.#unknown(agentRef, "unknown agentRef");
    await this.#refreshFromOfficial(state);
    if (state.pendingApproval) throw new Error(`agent ${agentRef} has a pending Codex approval`);
    const targetTurnId = state.currentTurnId;
    if (targetTurnId !== expectedTurnId) {
      throw new Error(`agent task turn changed: expected ${expectedTurnId}, current ${String(targetTurnId ?? "none")}`);
    }

    const hash = steerRequestHash(agentRef, targetTurnId, message);
    const prior = this.#controlRequestIds.get(clientRequestId);
    if (prior) {
      if (prior.requestHash !== hash) {
        throw new Error(`clientRequestId was already used for a different agent control action: ${clientRequestId}`);
      }
      if (prior.acceptance === "rejected") {
        throw new Error(prior.error ?? `turn/steer was rejected for agent ${agentRef}`);
      }
      await this.#refreshFromOfficial(state);
      if (prior.acceptance === "unknown" && prior.error) {
        const refreshError = state.latestError && state.latestError !== prior.error ? state.latestError : null;
        state.latestError = refreshError ? `${prior.error}; official refresh also failed: ${refreshError}` : prior.error;
      }
      return {
        ...this.#snapshot(state, 0),
        duplicate: true,
        controlAcceptance: prior.acceptance ?? "unknown",
      };
    }

    if (!state.threadId || state.status !== "running") {
      throw new Error(`agent has no steerable active turn: ${agentRef} (${state.status})`);
    }

    this.#assertControlCapacity();
    this.#admissionCheck?.();

    const record = {
      agentRef,
      requestHash: hash,
      action: "steer",
      targetId: targetTurnId,
      acceptance: "dispatching",
      error: null,
    };
    this.#controlRequestIds.set(clientRequestId, record);
    this.#appendEvent(state, {
      type: "turn/steer-dispatched",
      turnId: targetTurnId,
      requestId: clientRequestId,
      at: Date.now(),
    });

    try {
      const accepted = await this.#request("turn/steer", {
        threadId: state.threadId,
        clientUserMessageId: clientRequestId,
        input: [{ type: "text", text: message }],
        expectedTurnId: targetTurnId,
      });
      if (accepted?.turnId !== targetTurnId) {
        record.acceptance = "unknown";
        record.error = `turn/steer returned unexpected turn id ${String(accepted?.turnId ?? "missing")}; do not replay automatically`;
        state.latestError = record.error;
        state.updatedAt = Date.now();
        this.#appendEvent(state, {
          type: "turn/steer-acceptance-unknown",
          turnId: targetTurnId,
          requestId: clientRequestId,
          text: state.latestError,
          at: Date.now(),
        });
        return { ...this.#snapshot(state, 0), duplicate: false, controlAcceptance: "unknown" };
      }
      record.acceptance = "accepted";
      state.latestError = null;
      state.updatedAt = Date.now();
      this.#appendEvent(state, {
        type: "turn/steer-accepted",
        turnId: targetTurnId,
        requestId: clientRequestId,
        at: Date.now(),
      });
      return { ...this.#snapshot(state, 0), duplicate: false, controlAcceptance: "accepted" };
    } catch (error) {
      if (error instanceof CodexRpcError) {
        record.acceptance = "rejected";
        record.error = error.message;
        state.latestError = null;
        state.updatedAt = Date.now();
        this.#appendEvent(state, {
          type: "turn/steer-rejected",
          turnId: targetTurnId,
          requestId: clientRequestId,
          text: error.message,
          at: Date.now(),
        });
        throw error;
      }

      record.acceptance = "unknown";
      const acceptanceUnknown = `turn/steer acceptance unknown; do not replay automatically: ${error instanceof Error ? error.message : String(error)}`;
      record.error = acceptanceUnknown;
      state.latestError = acceptanceUnknown;
      state.updatedAt = Date.now();
      this.#appendEvent(state, {
        type: "turn/steer-acceptance-unknown",
        turnId: targetTurnId,
        requestId: clientRequestId,
        text: acceptanceUnknown,
        at: Date.now(),
      });
      await this.#refreshFromOfficial(state);
      if (state.latestError && state.latestError !== acceptanceUnknown) {
        state.latestError = `${acceptanceUnknown}; official refresh also failed: ${state.latestError}`;
      } else {
        state.latestError = acceptanceUnknown;
      }
      return { ...this.#snapshot(state, 0), duplicate: false, controlAcceptance: "unknown" };
    }
  }

  async #cancel({ agentRef, clientRequestId, expectedTurnId = null }) {
    this.#assertOpen();
    if (typeof clientRequestId !== "string" || !clientRequestId.trim()) {
      throw new Error("clientRequestId must be a non-empty string");
    }
    const state = this.#agents.get(agentRef);
    if (!state) return this.#unknown(agentRef, "unknown agentRef");
    await this.#refreshFromOfficial(state);
    const targetTurnId = state.currentTurnId;
    if (expectedTurnId !== null && expectedTurnId !== targetTurnId) {
      throw new Error(`agent task turn changed: expected ${expectedTurnId}, current ${String(targetTurnId ?? "none")}`);
    }
    const hash = controlRequestHash("cancel", agentRef, targetTurnId);
    const prior = this.#controlRequestIds.get(clientRequestId);
    if (prior) {
      if (prior.requestHash !== hash) {
        throw new Error(`clientRequestId was already used for a different agent control action: ${clientRequestId}`);
      }
      await this.#refreshFromOfficial(state);
      return { ...this.#snapshot(state, 0), duplicate: true, controlAcceptance: prior.acceptance ?? "accepted" };
    }
    if (!targetTurnId || !state.threadId || !["running", "awaitingApproval", "unknown"].includes(state.status)) {
      throw new Error(`agent has no interruptible active turn: ${agentRef} (${state.status})`);
    }
    const earlierCancel = [...this.#controlRequestIds.entries()].find(([, entry]) =>
      entry?.action === "cancel" &&
      entry?.agentRef === agentRef &&
      entry?.targetId === targetTurnId &&
      entry?.acceptance !== "rejected"
    );
    if (earlierCancel) {
      throw new Error(`cancel was already dispatched for this turn under requestId ${earlierCancel[0]}; query agent_show or retry that exact requestId instead of replaying turn/interrupt`);
    }
    this.#assertControlCapacity(true);

    const record = { agentRef, requestHash: hash, action: "cancel", targetId: targetTurnId, acceptance: "dispatching" };
    this.#controlRequestIds.set(clientRequestId, record);
    this.#appendEvent(state, { type: "turn/interrupt-dispatched", turnId: targetTurnId, requestId: clientRequestId, at: Date.now() });
    try {
      await this.#request("turn/interrupt", { threadId: state.threadId, turnId: targetTurnId });
      record.acceptance = "accepted";
      state.latestTurnStatus = "interrupted";
      if (!state.pendingApproval) state.status = "interrupted";
      state.latestError = null;
      if (state.turnEndedAt === null) {
        state.turnEndedAt = Date.now();
        state.turnDurationMs = state.turnStartedAt === null ? null : Math.max(0, state.turnEndedAt - state.turnStartedAt);
      }
      state.updatedAt = Date.now();
      this.#appendEvent(state, { type: "turn/interrupt-accepted", turnId: targetTurnId, requestId: clientRequestId, at: Date.now() });
      await this.#ensureResourceReceipt(state);
      return { ...this.#snapshot(state, 0), duplicate: false, controlAcceptance: "accepted" };
    } catch (error) {
      record.acceptance = "unknown";
      state.latestError = `turn/interrupt acceptance unknown; do not replay: ${error instanceof Error ? error.message : String(error)}`;
      state.status = "unknown";
      state.updatedAt = Date.now();
      this.#appendEvent(state, { type: "turn/interrupt-acceptance-unknown", turnId: targetTurnId, requestId: clientRequestId, text: state.latestError, at: Date.now() });
      await this.#refreshFromOfficial(state);
      if (state.latestTurnStatus === "interrupted") {
        record.acceptance = "accepted";
        state.latestError = null;
      } else if (["completed", "failed"].includes(state.latestTurnStatus)) {
        record.acceptance = "accepted";
      } else {
        state.status = "unknown";
      }
      await this.#ensureResourceReceipt(state);
      return { ...this.#snapshot(state, 0), duplicate: false, controlAcceptance: record.acceptance };
    }
  }

  async #send({ agentRef, message, clientRequestId = null, model = null, reasoningEffort = null, expectedParentTurnId = null }) {
    this.#assertOpen();
    if (typeof message !== "string" || !message.trim()) throw new Error("message must be a non-empty string");
    if (clientRequestId !== null && (typeof clientRequestId !== "string" || !clientRequestId.trim())) {
      throw new Error("clientRequestId must be a non-empty string when provided");
    }
    if (expectedParentTurnId !== null && (typeof expectedParentTurnId !== "string" || !expectedParentTurnId || expectedParentTurnId.length > 512)) {
      throw new Error("expectedParentTurnId must be a valid exact parent turn ID");
    }
    const requestedModel = normalizeModel(model);
    const requestedReasoningEffort = normalizeReasoningEffort(reasoningEffort);
    const requestHash = createHash("sha256").update(JSON.stringify({
      agentRef, message, model: requestedModel, reasoningEffort: requestedReasoningEffort, expectedParentTurnId,
    }), "utf8").digest("hex");
    let sendOperation = null;
    if (clientRequestId) {
      const pending = this.#sendOperations.get(clientRequestId);
      if (pending) {
        if (pending.requestHash !== requestHash) {
          throw new Error(`clientRequestId was already used for a different agent send: ${clientRequestId}`);
        }
        return { ...(await pending.promise), duplicate: true };
      }
      const prior = this.#sendRequestIds.get(clientRequestId);
      if (prior) {
        if (prior.requestHash !== requestHash) {
          throw new Error(`clientRequestId was already used for a different agent send: ${clientRequestId}`);
        }
        const priorState = this.#agents.get(prior.agentRef);
        if (!priorState) return this.#unknown(prior.agentRef, "accepted send mapping is no longer available");
        return { ...this.#snapshot(priorState, 0), duplicate: true };
      }
      if (this.#sendRequestIds.size + this.#sendOperations.size >= this.#maxRequestBindings) {
        throw Object.assign(new Error("Send request capacity reached; new request IDs are blocked without forgetting replay bindings"), { code: "CODEX_AGENT_CAPACITY" });
      }
      const activeRequestId = this.#activeSendByAgent.get(agentRef);
      if (activeRequestId && activeRequestId !== clientRequestId) {
        throw new Error(
          `agent ${agentRef} already has an in-flight send under clientRequestId ${activeRequestId}; do not dispatch a concurrent follow-up`
        );
      }
      let resolveOperation;
      let rejectOperation;
      const promise = new Promise((resolve, reject) => {
        resolveOperation = resolve;
        rejectOperation = reject;
      });
      promise.catch(() => {});
      sendOperation = { requestHash, promise, resolve: resolveOperation, reject: rejectOperation };
      this.#sendOperations.set(clientRequestId, sendOperation);
      this.#activeSendByAgent.set(agentRef, clientRequestId);
    }
    const activeSendToken = clientRequestId ?? `unkeyed_${randomUUID()}`;
    if (!clientRequestId) {
      if (this.#activeSendByAgent.has(agentRef)) throw new Error("agent already has an in-flight send; do not dispatch a concurrent follow-up");
      this.#activeSendByAgent.set(agentRef, activeSendToken);
    }
    const settleSendOperation = (kind, value) => {
      if (this.#activeSendByAgent.get(agentRef) === activeSendToken) this.#activeSendByAgent.delete(agentRef);
      if (!sendOperation || !clientRequestId) return;
      if (this.#sendOperations.get(clientRequestId) === sendOperation) {
        this.#sendOperations.delete(clientRequestId);
      }
      if (kind === "resolve") sendOperation.resolve(value);
      else sendOperation.reject(value);
    };

    let state;
    try {
      state = this.#agents.get(agentRef);
      if (!state) {
        const result = this.#unknown(agentRef, "unknown agentRef");
        settleSendOperation("resolve", result);
        return result;
      }

      const parentTurnId = expectedParentTurnId ?? state.currentTurnId;
      if (!parentTurnId || (expectedParentTurnId !== null && state.currentTurnId !== expectedParentTurnId)) {
        throw Object.assign(new Error("Codex parent turn changed; prepare a new follow-up"), { code: "CODEX_AGENT_PARENT_CHANGED" });
      }
      await this.#refreshFromOfficial(state);
      if (state.latestError) throw new Error("Codex official parent refresh failed; no follow-up was started");
      if (state.pendingApproval) throw new Error(`agent ${agentRef} has a pending Codex approval`);
      if (!new Set(["idle", "interrupted"]).has(state.status)) {
        throw new Error(`agent ${agentRef} is not ready for a follow-up: ${state.status}`);
      }
      await this.#assertCurrentParent(state, parentTurnId);

      const resumed = await this.#request("thread/resume", { threadId: state.threadId });
      if (resumed?.thread?.id !== state.threadId) {
        throw new Error("Codex thread/resume changed the bound thread; no follow-up was started");
      }
      await this.#assertBoundAuthority(state, resumed);
      await this.#assertChatgptAuth();
      if (resumed?.thread?.canAcceptDirectInput === false) {
        throw new Error(`Codex thread cannot accept direct input: ${state.threadId}`);
      }
      if (typeof resumed?.model === "string") state.resolvedModel = resumed.model;
      if (typeof resumed?.modelProvider === "string") state.modelProvider = resumed.modelProvider;
      state.serviceTier = typeof resumed?.serviceTier === "string" ? resumed.serviceTier : state.serviceTier;
      state.reasoningEffort = typeof resumed?.reasoningEffort === "string" ? resumed.reasoningEffort : state.reasoningEffort;

      if (requestedReasoningEffort) {
        await this.#validateReasoningEffort({
          requestedModel,
          currentModel: typeof resumed?.model === "string" ? resumed.model : state.resolvedModel,
          requestedReasoningEffort,
        });
      }

      // This is the final await before turn dispatch. The per-agent send lock
      // remains held across refresh, policy, authentication and model checks.
      await this.#assertCurrentParent(state, parentTurnId);
      this.#assertTurnAdmission();
      if (clientRequestId) this.#sendRequestIds.set(clientRequestId, { agentRef, requestHash });
    } catch (error) {
      settleSendOperation("reject", error);
      throw error;
    }

    // The next turn becomes the current logical turn as soon as dispatch begins.
    // Clear the previous completed-turn projection so an uncertain turn/start
    // response cannot make show() keep reporting the prior turn as current.
    state.currentTurnId = null;
    state.latestTurnStatus = null;
    state.latestTokenUsage = null;
    state.progressPlan = null;
    state.progressAgentMessage = null;
    state.progressActiveItem = null;
    state.resourceReceipt = null;
    state.resourceReceiptTurnId = null;
    state.resourceReceiptPromise = null;
    state.finalResult = null;
    state.latestError = null;
    state.status = "running";
    state.requestedModel = requestedModel;
    state.requestedReasoningEffort = requestedReasoningEffort;
    state.turnStartedAt = Date.now();
    state.turnEndedAt = null;
    state.turnDurationMs = null;
    state.updatedAt = Date.now();

    try {
      const turnStarted = await this.#request("turn/start", {
        threadId: state.threadId,
        clientUserMessageId: clientRequestId ?? `${agentRef}_${randomUUID()}`,
        input: [{ type: "text", text: message }],
        ...(requestedModel ? { model: requestedModel } : {}),
        ...(requestedReasoningEffort ? { effort: requestedReasoningEffort } : {}),
      });
      const turn = turnStarted?.turn;
      if (typeof turn?.id !== "string" || !turn.id) throw new Error("turn/start returned no turn id");
      state.currentTurnId = turn.id;
      state.latestTurnStatus = turn.status ?? "inProgress";
      state.status = state.pendingApproval ? "awaitingApproval" : normalizeAgentStatus(state.latestTurnStatus);
      if (state.status === "unknown") state.status = "running";
      state.finalResult = null;
      state.latestError = null;
      if (requestedModel) state.resolvedModel = null;
      state.updatedAt = Date.now();
      this.#appendEvent(state, { type: "turn/accepted", turnId: turn.id, status: turn.status ?? null, model: state.resolvedModel, at: Date.now() });
      const result = { ...this.#snapshot(state, 0), duplicate: false };
      settleSendOperation("resolve", result);
      return result;
    } catch (error) {
      state.latestError = error instanceof Error ? error.message : String(error);
      if (state.pendingApproval) {
        if (!state.currentTurnId && state.pendingApproval.turnId) state.currentTurnId = state.pendingApproval.turnId;
        if (!state.latestTurnStatus) state.latestTurnStatus = "inProgress";
        state.status = "awaitingApproval";
      } else {
        state.status = "unknown";
      }
      state.updatedAt = Date.now();
      this.#appendEvent(state, { type: "turn/acceptance-unknown", text: state.latestError, at: Date.now() });
      const result = { ...this.#snapshot(state, 0), duplicate: false };
      settleSendOperation("resolve", result);
      return result;
    }
  }

  async listModels(input) { return this.#track(() => this.#listModels(input)); }
  async start(input) { return this.#track(() => this.#start(input)); }
  async show(input) { return this.#track(() => this.#show(input), true); }
  async resolvePendingRequest(input) { return this.#track(() => this.#resolvePendingRequest(input)); }
  async rejectPendingRequest(input) { return this.#track(() => this.#rejectPendingRequest(input), true); }
  async resolveApproval(input) { return this.#track(() => this.#resolveApproval(input), input?.decision === "reject"); }
  async cancel(input) { return this.#track(() => this.#cancel(input), true); }
  async send(input) { return this.#track(() => this.#send(input)); }
  async steer(input) { return this.#track(() => this.#steer(input)); }

  #assertControlCapacity(safetyControl = false) {
    const safetyHeadroom = safetyControl ? Math.min(this.#maxAgents * 4, 10_000) : 0;
    const limit = Math.min(100_000, this.#maxControlBindings + safetyHeadroom);
    if (this.#controlRequestIds.size >= limit) {
      throw Object.assign(new Error("Control request capacity reached; new request IDs are blocked without forgetting replay bindings"), { code: "CODEX_AGENT_CAPACITY" });
    }
  }

  #track(factory, safetyControl = false) {
    this.#assertOpen();
    const limit = this.#maxInFlight + (safetyControl ? Math.min(32, this.#maxAgents) : 0);
    if (this.#operations.size >= limit) {
      throw Object.assign(new Error("Too many in-flight agent operations"), { code: "CODEX_AGENT_CAPACITY" });
    }
    const operation = Promise.resolve().then(async () => {
      this.#assertOpen();
      const result = await factory();
      this.#assertOpen();
      return result;
    });
    this.#operations.add(operation);
    operation.finally(() => this.#operations.delete(operation)).catch(() => {});
    return operation;
  }

  async #request(method, params, options) {
    this.#assertOpen();
    const result = await this.#client.request(method, params, options);
    this.#assertOpen();
    return result;
  }

  async #assertChatgptAuth() {
    if (!this.#requireChatgptAuth) return;
    let result;
    try { result = await this.#request("account/read", { refreshToken: false }); }
    catch {
      throw Object.assign(new Error("CODEX_ACCOUNT_AUTH_UNAVAILABLE: the selected account's ChatGPT login could not be verified"), { code: "CODEX_ACCOUNT_AUTH_UNAVAILABLE" });
    }
    if (result?.account?.type !== "chatgpt") {
      throw Object.assign(new Error("CODEX_ACCOUNT_AUTH_REQUIRED: this account requires its own official ChatGPT login; no fallback is allowed"), { code: "CODEX_ACCOUNT_AUTH_REQUIRED" });
    }
  }

  async #assertBoundAuthority(state, projection) {
    if (!state.authorityPolicyHash) {
      if (!this.#requireAuthorityPolicy) return;
      throw Object.assign(new Error("CODEX_AGENT_AUTHORITY_MISMATCH: no prepared account authority policy"), { code: "CODEX_AGENT_AUTHORITY_MISMATCH" });
    }
    const mismatch = () => Object.assign(new Error("CODEX_AGENT_AUTHORITY_MISMATCH: selected account effective authority differs from the prepared policy; no Codex turn was started"), { code: "CODEX_AGENT_AUTHORITY_MISMATCH" });
    if (projection?.activePermissionProfile?.id !== state.permissionProfile) throw mismatch();
    const configRead = await this.#request("config/read", { cwd: state.cwd, includeLayers: false });
    const effectiveConfig = configRead?.config;
    if (!effectiveConfig || typeof effectiveConfig !== "object" || Array.isArray(effectiveConfig)) throw mismatch();
    const listed = await this.#request("permissionProfile/list", { cwd: state.cwd });
    const permissionRows = (Array.isArray(listed?.data) ? listed.data : [])
      .filter((row) => row?.allowed === true && typeof row?.id === "string");
    if (!permissionRows.some((row) => row.id === state.permissionProfile)) throw mismatch();
    const observedPolicyHash = computeCodexAuthorityPolicyHash({
      effectiveConfig, permissionRows,
      authorityProfile: { permissionProfile: state.permissionProfile, permissionCeiling: state.permissionCeiling },
      started: projection,
    });
    if (observedPolicyHash !== state.authorityPolicyHash) throw mismatch();
  }

  async #assertCurrentParent(state, expectedParentTurnId) {
    const turns = await this.#request("thread/turns/list", {
      threadId: state.threadId, limit: 1, sortDirection: "desc",
    });
    const current = Array.isArray(turns?.data) ? turns.data[0] : null;
    if (!current || current.id !== expectedParentTurnId || state.currentTurnId !== expectedParentTurnId) {
      throw Object.assign(new Error("Codex parent turn changed or official parent state is unavailable; prepare a new follow-up"), { code: "CODEX_AGENT_PARENT_CHANGED" });
    }
    const localFollowUpReady = new Set(["idle", "interrupted"]).has(state.status);
    if (!FOLLOW_UP_PARENT_STATUSES.has(current.status) || state.pendingApproval || !localFollowUpReady) {
      throw Object.assign(new Error("Codex official parent turn is not safely follow-up-ready; no follow-up was started"), { code: "CODEX_AGENT_PARENT_NOT_IDLE" });
    }
  }

  async #currentModelCatalog() {
    const models = [];
    const seenCursors = new Set();
    let cursor = null;
    for (let page = 0; page < 20; page += 1) {
      const result = await this.listModels({ cursor, limit: 200, includeHidden: true });
      models.push(...result.models);
      if (!result.nextCursor) return models;
      if (seenCursors.has(result.nextCursor)) throw new Error("Codex model catalog pagination repeated a cursor");
      seenCursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new Error("Codex model catalog exceeded the bounded pagination limit");
  }

  async #validateReasoningEffort({ requestedModel, currentModel, requestedReasoningEffort }) {
    let catalog;
    try {
      catalog = await this.#currentModelCatalog();
    } catch (error) {
      const modelLabel = requestedModel ?? currentModel ?? "<unresolved>";
      throw new Error(
        `reasoningEffort validation failed for model "${modelLabel}": requested effort "${requestedReasoningEffort}"; supported efforts unknown; current model catalog unavailable: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    let effectiveModel = requestedModel ?? currentModel ?? null;
    if (!effectiveModel) {
      const defaults = catalog.filter((entry) => entry?.isDefault === true && modelIdentity(entry));
      if (defaults.length === 1) effectiveModel = modelIdentity(defaults[0]);
    }
    if (!effectiveModel) {
      throw new Error(
        `reasoningEffort validation failed for model "<unresolved>": requested effort "${requestedReasoningEffort}"; supported efforts unknown; current/default model could not be resolved from the current Codex model catalog`
      );
    }

    const entry = catalog.find((candidate) => candidate?.model === effectiveModel || candidate?.id === effectiveModel) ?? null;
    if (!entry) {
      throw new Error(
        `reasoningEffort validation failed for model "${effectiveModel}": requested effort "${requestedReasoningEffort}"; supported efforts unknown; model is not present in the current Codex model catalog`
      );
    }
    const supported = supportedReasoningEfforts(entry);
    if (!supported.includes(requestedReasoningEffort)) {
      throw new Error(
        `reasoningEffort validation failed for model "${effectiveModel}": requested effort "${requestedReasoningEffort}"; supported efforts: ${supported.length ? supported.join(", ") : "(none)"}`
      );
    }
    return { effectiveModel, supportedReasoningEfforts: supported };
  }

  async #refreshFromOfficial(state) {
    if (!state.threadId) return;
    try {
      const turns = await this.#request("thread/turns/list", {
        threadId: state.threadId,
        limit: 20,
      });
      const data = Array.isArray(turns?.data) ? turns.data : [];
      const turn = state.currentTurnId
        ? data.find((candidate) => candidate?.id === state.currentTurnId)
        : data[0];
      if (!turn) return;
      const currentTurnAlreadyTerminal = state.turnEndedAt !== null || TERMINAL_TURN_STATUSES.has(state.latestTurnStatus);
      const officialTurnIsTerminal = TERMINAL_TURN_STATUSES.has(turn.status);
      if (currentTurnAlreadyTerminal && !officialTurnIsTerminal) {
        const resumed = await this.#request("thread/resume", { threadId: state.threadId });
        if (typeof resumed?.model === "string") state.resolvedModel = resumed.model;
        if (typeof resumed?.modelProvider === "string") state.modelProvider = resumed.modelProvider;
        state.serviceTier = typeof resumed?.serviceTier === "string" ? resumed.serviceTier : state.serviceTier;
        state.reasoningEffort = typeof resumed?.reasoningEffort === "string" ? resumed.reasoningEffort : state.reasoningEffort;
        state.updatedAt = Date.now();
        this.#appendEvent(state, { type: "nonterminal-official-refresh-ignored", turnId: turn.id, status: turn.status ?? null, at: Date.now() });
        return;
      }
      state.currentTurnId = turn.id;
      state.latestTurnStatus = turn.status ?? state.latestTurnStatus;
      state.status = normalizeAgentStatus(turn.status);
      if (state.pendingApproval) state.status = "awaitingApproval";
      if (turn.status === "completed") {
        state.lastCompletedTurnId = turn.id;
        state.finalResult = lastAgentMessage(turn);
        state.latestError = null;
      } else if (turn.status === "failed") {
        state.latestError = turn?.error?.message ?? JSON.stringify(turn?.error ?? "turn failed");
      } else if (turn.status === "interrupted") {
        state.finalResult = lastAgentMessage(turn) ?? state.finalResult;
        state.latestError = null;
      }
      if (TERMINAL_TURN_STATUSES.has(turn.status) && state.turnEndedAt === null) {
        state.turnEndedAt = Date.now();
        state.turnDurationMs = state.turnStartedAt === null ? null : Math.max(0, state.turnEndedAt - state.turnStartedAt);
      }
      if (TERMINAL_TURN_STATUSES.has(turn.status)) {
        const resumed = await this.#request("thread/resume", { threadId: state.threadId });
        if (typeof resumed?.model === "string") state.resolvedModel = resumed.model;
        if (typeof resumed?.modelProvider === "string") state.modelProvider = resumed.modelProvider;
        state.serviceTier = typeof resumed?.serviceTier === "string" ? resumed.serviceTier : state.serviceTier;
        state.reasoningEffort = typeof resumed?.reasoningEffort === "string" ? resumed.reasoningEffort : state.reasoningEffort;
      }
      state.updatedAt = Date.now();
    } catch (error) {
      if (this.#closed) throw error;
      state.latestError = error instanceof Error ? error.message : String(error);
      if (state.status === "starting") state.status = "unknown";
      state.updatedAt = Date.now();
      this.#appendEvent(state, { type: "official-refresh-error", text: state.latestError, at: Date.now() });
    }
  }

  #onNotification(message) {
    if (this.#closed) return;
    const threadId = notificationThreadId(message);
    const turnId = notificationTurnId(message);
    const requestId = notificationRequestId(message);
    const state = [...this.#agents.values()].find((candidate) =>
      (threadId && candidate.threadId === threadId) ||
      (turnId && candidate.currentTurnId === turnId) ||
      (requestId !== null && candidate.pendingApproval && String(candidate.pendingApproval.requestId) === String(requestId))
    );
    if (!state) return;

    const turn = notificationTurn(message);
    const turnScopedProgressEvent = message.method === "turn/plan/updated" || message.method.startsWith("item/");
    if ((["turn/started", "turn/completed"].includes(message.method) || turnScopedProgressEvent)
      && turnId && state.currentTurnId && turnId !== state.currentTurnId) {
      state.updatedAt = Date.now();
      this.#appendEvent(state, { type: "stale-turn-notification-ignored", method: message.method, turnId, currentTurnId: state.currentTurnId, at: Date.now() });
      return;
    }
    if (turnId && !state.currentTurnId) state.currentTurnId = turnId;
    if (message.method === "thread/tokenUsage/updated" && message?.params?.tokenUsage) {
      state.latestTokenUsage = structuredClone(message.params.tokenUsage);
    }
    if (message.method === "turn/plan/updated") {
      state.progressPlan = boundedPlan(message.params);
    }
    if (message.method === "item/started" && message?.params?.item?.id) {
      const item = message.params.item;
      state.approvalItems.set(item.id, structuredClone(item));
      if (state.approvalItems.size > 32) {
        const oldest = state.approvalItems.keys().next().value;
        state.approvalItems.delete(oldest);
      }
      if (item.type === "userMessage" && typeof item.clientId === "string" && item.clientId) {
        const control = this.#controlRequestIds.get(item.clientId);
        if (
          control?.action === "steer" &&
          control.agentRef === state.agentRef &&
          control.targetId === (turnId ?? state.currentTurnId) &&
          control.acceptance !== "rejected" &&
          control.consumption !== "consumed"
        ) {
          control.consumption = "consumed";
          control.consumedAt = Date.now();
          this.#appendEvent(state, {
            type: "turn/steer-consumed",
            turnId: turnId ?? state.currentTurnId,
            requestId: item.clientId,
            at: control.consumedAt,
          });
        }
      }
      state.progressActiveItem = compactActiveItem(item);
      if (item.type === "agentMessage") {
        const bounded = boundedProgressText(item.text ?? "");
        state.progressAgentMessage = {
          itemId: item.id,
          phase: typeof item.phase === "string" ? item.phase : null,
          text: bounded.text,
          truncated: bounded.truncated,
          status: "inProgress",
          updatedAt: Date.now(),
        };
      }
    }
    if (message.method === "item/agentMessage/delta") {
      const delta = message?.params?.delta;
      if (typeof delta === "string") {
        const itemId = typeof message?.params?.itemId === "string"
          ? message.params.itemId
          : state.progressAgentMessage?.itemId ?? null;
        const sameItem = state.progressAgentMessage?.itemId === itemId;
        const priorText = sameItem ? state.progressAgentMessage?.text ?? "" : "";
        const bounded = boundedProgressText(priorText + delta);
        state.progressAgentMessage = {
          itemId,
          phase: sameItem ? state.progressAgentMessage?.phase ?? null : null,
          text: bounded.text,
          truncated: (sameItem && state.progressAgentMessage?.truncated === true) || bounded.truncated,
          status: "inProgress",
          updatedAt: Date.now(),
        };
      }
    }
    if (message.method === "item/completed" && message?.params?.item?.id) {
      const item = message.params.item;
      state.approvalItems.delete(item.id);
      if (state.progressActiveItem?.id === item.id) state.progressActiveItem = null;
      if (item.type === "agentMessage") {
        const bounded = boundedProgressText(item.text ?? state.progressAgentMessage?.text ?? "");
        state.progressAgentMessage = {
          itemId: item.id,
          phase: typeof item.phase === "string" ? item.phase : state.progressAgentMessage?.phase ?? null,
          text: bounded.text,
          truncated: bounded.truncated,
          status: "completed",
          updatedAt: Date.now(),
        };
      }
    }
    if (message.method === "serverRequest/resolved") {
      if (state.pendingApproval && String(state.pendingApproval.requestId) === String(requestId)) {
        state.pendingApproval = null;
        state.pendingRequestHandle = null;
        state.status = normalizeAgentStatus(state.latestTurnStatus);
        if (state.status === "unknown") state.status = "running";
      }
    } else if (message.method === "turn/started") {
      const currentTurnAlreadyTerminal = state.turnEndedAt !== null || TERMINAL_TURN_STATUSES.has(state.latestTurnStatus);
      if (!currentTurnAlreadyTerminal) {
        state.latestTurnStatus = turn?.status ?? "inProgress";
        state.status = state.pendingApproval ? "awaitingApproval" : "running";
        if (state.turnStartedAt === null) state.turnStartedAt = Date.now();
      }
    } else if (message.method === "turn/completed") {
      const status = turn?.status ?? "completed";
      state.latestTurnStatus = status;
      state.status = normalizeAgentStatus(status);
      if (status === "completed") {
        state.lastCompletedTurnId = turn?.id ?? state.currentTurnId;
        state.finalResult = lastAgentMessage(turn) ?? state.finalResult;
        state.latestError = null;
      } else if (status === "failed") {
        state.latestError = turn?.error?.message ?? JSON.stringify(turn?.error ?? "turn failed");
      } else if (status === "interrupted") {
        state.finalResult = lastAgentMessage(turn) ?? state.finalResult;
        state.latestError = null;
      }
      if (TERMINAL_TURN_STATUSES.has(status) && state.turnEndedAt === null) {
        state.turnEndedAt = Date.now();
        state.turnDurationMs = state.turnStartedAt === null ? null : Math.max(0, state.turnEndedAt - state.turnStartedAt);
      }
    } else if (message.method === "thread/status/changed") {
      const type = message?.params?.status?.type;
      const currentTurnTerminal = state.turnEndedAt !== null || TERMINAL_TURN_STATUSES.has(state.latestTurnStatus);
      if (type === "active" && !currentTurnTerminal) state.status = state.pendingApproval ? "awaitingApproval" : "running";
      if (type === "idle" && state.status === "running") state.status = "idle";
      if (type === "systemError" && !currentTurnTerminal) state.status = "failed";
    }
    state.updatedAt = Date.now();
    this.#appendEvent(state, compactNotification(message));
  }

  #onServerRequest(request) {
    if (this.#closed) { request.reject({ code: -32000, message: "Agent executor is closing" }); return; }
    const params = request?.params && typeof request.params === "object" ? request.params : {};
    const threadId = params.threadId ?? null;
    const turnId = params.turnId ?? null;
    const state = [...this.#agents.values()].find((candidate) => threadId
      ? candidate.threadId === threadId && (!turnId || !candidate.currentTurnId || candidate.currentTurnId === turnId)
      : turnId && candidate.currentTurnId === turnId
    );
    if (!state) {
      request.reject({
        code: -32602,
        message: `Agent server request could not be mapped to an active agent: ${request.method}`,
      });
      return;
    }
    if (turnId && !state.currentTurnId) state.currentTurnId = turnId;
    if (!state.latestTurnStatus) state.latestTurnStatus = "inProgress";
    if (state.pendingApproval) {
      request.reject({
        code: -32000,
        message: `Agent already has a pending server request: ${String(state.pendingApproval.requestId)}`,
      });
      return;
    }

    state.pendingApproval = approvalSummary(request, state.approvalItems.get(params.itemId ?? params.item?.id ?? null) ?? null);
    state.pendingRequestHandle = request;
    state.status = "awaitingApproval";
    state.updatedAt = Date.now();
    this.#appendEvent(state, {
      type: "server-request/pending",
      requestId: request.id,
      method: request.method,
      turnId: state.pendingApproval.turnId,
      at: state.pendingApproval.receivedAt,
    });
  }

  #appendEvent(state, event) {
    state.events.push({ seq: this.#nextEventSeq++, ...event });
    if (state.events.length > this.#maxEvents) state.events.splice(0, state.events.length - this.#maxEvents);
  }

  async #ensureResourceReceipt(state) {
    if (!state?.currentTurnId || !TERMINAL_TURN_STATUSES.has(state.latestTurnStatus)) return state?.resourceReceipt ?? null;
    if (state.resourceReceipt && state.resourceReceiptTurnId === state.currentTurnId) return state.resourceReceipt;
    if (state.resourceReceiptPromise) return await state.resourceReceiptPromise;

    const turnId = state.currentTurnId;
    state.resourceReceiptPromise = (async () => {
      let quotaSnapshot;
      try {
        quotaSnapshot = this.#resourceSnapshotProvider
          ? await this.#resourceSnapshotProvider({
              agentRef: state.agentRef,
              threadId: state.threadId,
              turnId,
              cwd: state.cwd,
            })
          : {
              status: "unavailable",
              observedAt: new Date().toISOString(),
              usage: { status: "unavailable", error: { name: "Unavailable", message: "resource telemetry provider is not configured" } },
              rateLimits: { status: "unavailable", error: { name: "Unavailable", message: "resource telemetry provider is not configured" } },
            };
      } catch (error) {
        const projected = {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        };
        quotaSnapshot = {
          status: "unavailable",
          observedAt: new Date().toISOString(),
          usage: { status: "unavailable", error: projected },
          rateLimits: { status: "unavailable", error: projected },
        };
      }
      const receipt = buildAgentResourceReceipt({
        turnId,
        turnStatus: state.latestTurnStatus,
        tokenUsage: state.latestTokenUsage,
        quotaSnapshot,
      });
      state.resourceReceipt = receipt;
      state.resourceReceiptTurnId = turnId;
      state.updatedAt = Date.now();
      this.#appendEvent(state, { type: "resource-receipt/ready", turnId, at: Date.now() });
      return receipt;
    })();
    try {
      return await state.resourceReceiptPromise;
    } finally {
      state.resourceReceiptPromise = null;
    }
  }

  #snapshot(state, afterSeq) {
    const events = state.events.filter((event) => event.seq > afterSeq);
    const nextSeq = state.events.length ? state.events[state.events.length - 1].seq : afterSeq;
    return {
      agentRef: state.agentRef,
      threadId: state.threadId,
      turnId: state.currentTurnId,
      status: state.status,
      latestTurnStatus: state.latestTurnStatus,
      canSend: new Set(["idle", "interrupted"]).has(state.status) && !state.pendingApproval,
      pendingApproval: state.pendingApproval ? { ...state.pendingApproval } : null,
      finalResult: state.finalResult,
      progress: {
        latestAgentMessage: state.progressAgentMessage ? structuredClone(state.progressAgentMessage) : null,
        plan: state.progressPlan ? structuredClone(state.progressPlan) : null,
        activeItem: state.progressActiveItem ? structuredClone(state.progressActiveItem) : null,
      },
      resourceReceipt: state.resourceReceipt ? structuredClone(state.resourceReceipt) : null,
      latestError: state.latestError,
      lastCompletedTurnId: state.lastCompletedTurnId,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      timing: {
        startedAt: state.turnStartedAt,
        endedAt: state.turnEndedAt,
        durationMs: state.turnDurationMs,
      },
      execution: {
        requestedModel: state.requestedModel,
        ...(state.requestedReasoningEffort ? { requestedReasoningEffort: state.requestedReasoningEffort } : {}),
        resolvedModel: state.resolvedModel,
        modelProvider: state.modelProvider,
        serviceTier: state.serviceTier,
        reasoningEffort: state.reasoningEffort,
      },
      events,
      nextSeq,
      serverRequestMethods: this.#client.serverRequestMethods,
    };
  }

  #unknown(agentRef, message) {
    return {
      agentRef: typeof agentRef === "string" ? agentRef : null,
      threadId: null,
      turnId: null,
      status: "unknown",
      latestTurnStatus: null,
      canSend: false,
      pendingApproval: null,
      finalResult: null,
      progress: { latestAgentMessage: null, plan: null, activeItem: null },
      resourceReceipt: null,
      latestError: message,
      lastCompletedTurnId: null,
      timing: { startedAt: null, endedAt: null, durationMs: null },
      execution: { requestedModel: null, resolvedModel: null, modelProvider: null, serviceTier: null, reasoningEffort: null },
      events: [],
      nextSeq: 0,
      serverRequestMethods: this.#client.serverRequestMethods,
    };
  }

  #assertOpen() {
    if (!this.#opened || this.#closed || !this.#client.running) {
      throw new Error("CodexAgentExecutor is not open");
    }
  }
}
