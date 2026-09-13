import { createHash, randomUUID } from "node:crypto";
import { resolveCodexAccount } from "./codex-account-registry.mjs";

function requestBindingHash(method, accountId, input = {}) {
  const material = {
    method, accountId, agentRef: input.agentRef ?? null,
    ...(method === "start" ? {
      cwd: input.cwd ?? null, task: input.task ?? null,
      permissionProfile: input.permissionProfile ?? null,
      permissionCeiling: input.permissionCeiling ?? null,
      authorityPolicyHash: input.authorityPolicyHash ?? null,
    } : {}),
    ...(["start", "send"].includes(method) ? {
      model: input.model ?? null, reasoningEffort: input.reasoningEffort ?? null,
    } : {}),
    ...(method === "send" ? { message: input.message ?? null, expectedParentTurnId: input.expectedParentTurnId ?? null } : {}),
    ...(method === "steer" ? { message: input.message ?? null, expectedTurnId: input.expectedTurnId ?? null } : {}),
    ...(method === "cancel" ? { expectedTurnId: input.expectedTurnId ?? null } : {}),
    ...(method === "resolveApproval" ? {
      approvalRequestId: input.approvalRequestId ?? null, decision: input.decision ?? null,
    } : {}),
    ...(method === "resolvePendingRequest" ? { requestId: input.requestId ?? null, result: input.result ?? null } : {}),
    ...(method === "rejectPendingRequest" ? { requestId: input.requestId ?? null, error: input.error ?? null } : {}),
  };
  return createHash("sha256").update(JSON.stringify(material), "utf8").digest("hex");
}

function authorityLeaseHash({ accountId, delegateEpoch, securityPolicyHash, effectiveCwd, permissionProfile, permissionCeiling }) {
  return createHash("sha256").update(JSON.stringify({
    schemaVersion: 1,
    accountId,
    delegateEpoch,
    securityPolicyHash,
    effectiveCwd,
    permissionProfile,
    permissionCeiling,
  }), "utf8").digest("hex");
}

function poolError(code, message) {
  return Object.assign(new Error(message), { code });
}

function requestId(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 512) {
    throw poolError("CODEX_REQUEST_INVALID", "clientRequestId must be an exact non-empty string of at most 512 characters");
  }
  return value;
}

function isSafetyControl(method, input) {
  return method === "cancel" || method === "rejectPendingRequest"
    || (method === "resolveApproval" && input.decision === "reject");
}

export class CodexAccountAgentExecutor {
  #registry;
  #factory;
  #quotaProvider;
  #preflightProvider;
  #preStartAuthorityCheck;
  #maxRequests;
  #maxAgents;
  #maxInFlight;
  #pendingStarts = 0;
  #delegates = new Map();
  #delegatePromises = new Map();
  #delegateEpochs = new Map();
  #authorityBindings = new Map();
  #agentAccounts = new Map();
  #requestBindings = new Map();
  #operations = new Set();
  #providerPromises = new Map();
  #cleanupFailures = new Map();
  #closePromise = null;
  #closed = false;

  constructor({ registry, factory, quotaProvider = null, preflightProvider = null, preStartAuthorityCheck = null,
    maxRequests = 10_000, maxAgents = 1_000, maxInFlight = 128 } = {}) {
    if (!registry || !Array.isArray(registry.accounts) || !registry.accounts.length || registry.accounts.length > 32) {
      throw new Error("CodexAccountAgentExecutor requires an account registry with 1..32 accounts");
    }
    if (typeof factory !== "function") throw new Error("CodexAccountAgentExecutor requires a delegate factory");
    if (quotaProvider !== null && typeof quotaProvider !== "function") throw new Error("quotaProvider must be a function when provided");
    if (preflightProvider !== null && typeof preflightProvider !== "function") throw new Error("preflightProvider must be a function when provided");
    if (preStartAuthorityCheck !== null && typeof preStartAuthorityCheck !== "function") throw new Error("preStartAuthorityCheck must be a function when provided");
    for (const [name, value] of Object.entries({ maxRequests, maxAgents, maxInFlight })) {
      if (!Number.isInteger(value) || value < 1 || value > 100_000) throw new Error(`${name} must be 1..100000`);
    }
    this.#registry = Object.freeze({ ...registry,
      accounts: Object.freeze(registry.accounts.map((account) => Object.freeze({ ...account }))),
    });
    this.#factory = factory;
    this.#quotaProvider = quotaProvider;
    this.#preflightProvider = preflightProvider;
    this.#preStartAuthorityCheck = preStartAuthorityCheck;
    this.#maxRequests = maxRequests;
    this.#maxAgents = maxAgents;
    this.#maxInFlight = maxInFlight;
  }

  get running() {
    return !this.#closed && [...this.#delegates.values()].some((delegate) => delegate?.running === true);
  }

  async open() {
    this.#assertOpen();
    return { deferred: true, accounts: this.#registry.accounts.map((entry) => entry.id) };
  }

  async close() {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = (async () => {
      const closing = [...this.#delegates.entries()].map(async ([id, delegate]) => {
        try { await delegate.close(); }
        catch { this.#quarantineAccount(id); }
      });
      await Promise.allSettled([...closing, ...this.#operations, ...this.#delegatePromises.values()]);
      this.#delegates.clear();
      this.#delegatePromises.clear();
      this.#delegateEpochs.clear();
      this.#authorityBindings.clear();
      this.#agentAccounts.clear();
      this.#requestBindings.clear();
      this.#operations.clear();
      this.#providerPromises.clear();
      if (this.#cleanupFailures.size) {
        throw poolError("CODEX_ACCOUNT_CLEANUP_FAILED", "One or more account App Servers could not be closed; do not restart this pool automatically");
      }
    })();
    return this.#closePromise;
  }

  resolveAccountId(account = null) {
    const selected = resolveCodexAccount(this.#registry, account);
    return this.#registry.source === "legacy" && account === null ? null : selected.id;
  }

  accountForAgent(agentRef) {
    return this.#registry.source === "legacy" ? null : this.#agentAccounts.get(agentRef) ?? null;
  }

  async listModels({ account = null, ...input } = {}) {
    this.#assertOpen();
    const selected = resolveCodexAccount(this.#registry, account);
    const bound = structuredClone(input);
    return this.#track(async () => {
      const delegate = await this.#delegate(selected);
      this.#assertOpen();
      return delegate.listModels(bound);
    });
  }

  async prepareAuthority({ account = null, ...input } = {}) {
    this.#assertOpen();
    const selected = resolveCodexAccount(this.#registry, account);
    const bound = structuredClone(input);
    return this.#track(async () => {
      const delegate = await this.#delegate(selected);
      const delegateEpoch = this.#delegateEpochs.get(selected.id) ?? null;
      if (!delegateEpoch || typeof delegate.prepareAuthority !== "function") {
        throw poolError("CODEX_AGENT_AUTHORITY_UNAVAILABLE", "Selected account runtime cannot prepare formal-agent authority");
      }
      const authority = await delegate.prepareAuthority(bound);
      if (this.#delegates.get(selected.id) !== delegate || this.#delegateEpochs.get(selected.id) !== delegateEpoch || delegate.running !== true) {
        throw poolError("CODEX_AGENT_PREPARED_DELEGATE_STALE", "Selected account runtime changed while authority was being prepared; prepare a new Codex task");
      }
      const securityPolicyHash = authority?.policyHash;
      if (typeof securityPolicyHash !== "string" || !/^[0-9a-f]{64}$/.test(securityPolicyHash)) {
        throw poolError("CODEX_AGENT_AUTHORITY_UNAVAILABLE", "Selected account runtime returned no valid authority policy hash");
      }
      const leaseHash = authorityLeaseHash({
        accountId: selected.id,
        delegateEpoch,
        securityPolicyHash,
        effectiveCwd: authority.effectiveCwd,
        permissionProfile: authority.permissionProfile,
        permissionCeiling: authority.permissionCeiling,
      });
      if (!this.#authorityBindings.has(leaseHash) && this.#authorityBindings.size >= this.#maxRequests) {
        throw poolError("CODEX_ACCOUNT_CAPACITY", "Prepared authority binding capacity reached; new formal-agent starts are blocked without evicting existing bindings");
      }
      this.#authorityBindings.set(leaseHash, Object.freeze({
        accountId: selected.id,
        delegateEpoch,
        securityPolicyHash,
        effectiveCwd: authority.effectiveCwd,
        permissionProfile: authority.permissionProfile,
        permissionCeiling: authority.permissionCeiling,
      }));
      return { ...authority, securityPolicyHash, policyHash: leaseHash };
    });
  }

  async accountPreflight({ account = null } = {}) {
    this.#assertOpen();
    if (!this.#preflightProvider) throw new Error("account preflight is unavailable");
    const selected = resolveCodexAccount(this.#registry, account);
    return this.#providerCall(selected, this.#preflightProvider);
  }

  async quotaSnapshot({ account = null, agentRef = null } = {}) {
    this.#assertOpen();
    if (!this.#quotaProvider) throw new Error("account quota snapshot is unavailable");
    if (agentRef && account !== null) throw poolError("CODEX_ACCOUNT_IMMUTABLE", "Agent quota reads cannot override the bound account");
    const selected = agentRef ? this.#accountForAgent(agentRef) : resolveCodexAccount(this.#registry, account);
    return this.#providerCall(selected, this.#quotaProvider);
  }

  async start({ account = null, clientRequestId = null, ...input } = {}) {
    this.#assertOpen();
    const selected = resolveCodexAccount(this.#registry, account);
    const bound = { ...structuredClone(input), clientRequestId: requestId(clientRequestId) };
    return this.#boundRequest("start", selected, bound, async () => {
      if (this.#agentAccounts.size + this.#pendingStarts >= this.#maxAgents) {
        throw poolError("CODEX_ACCOUNT_CAPACITY", "Agent capacity reached; new starts are blocked without evicting existing bindings");
      }
      this.#pendingStarts += 1;
      try {
        const delegate = await this.#delegate(selected);
        this.#assertOpen();
        let delegateInput = bound;
        if (this.#registry.source === "registry" && bound.authorityPolicyHash && this.#preStartAuthorityCheck) {
          const leaseHash = bound.authorityPolicyHash;
          const binding = typeof leaseHash === "string" ? this.#authorityBindings.get(leaseHash) : null;
          const currentEpoch = this.#delegateEpochs.get(selected.id) ?? null;
          if (!binding || binding.accountId !== selected.id || binding.delegateEpoch !== currentEpoch
            || binding.effectiveCwd !== bound.cwd || binding.permissionProfile !== bound.permissionProfile
            || binding.permissionCeiling !== bound.permissionCeiling) {
            throw poolError("CODEX_AGENT_PREPARED_DELEGATE_STALE", "Prepared Codex authority is not bound to the current selected-account runtime; prepare a new Codex task");
          }
          await this.#preStartAuthorityCheck({
            account: selected,
            binding: structuredClone(binding),
            input: structuredClone(bound),
          });
          this.#assertOpen();
          if (this.#delegates.get(selected.id) !== delegate || this.#delegateEpochs.get(selected.id) !== currentEpoch || delegate.running !== true) {
            throw poolError("CODEX_AGENT_PREPARED_DELEGATE_STALE", "Selected account runtime changed during final authority validation; prepare a new Codex task");
          }
          delegateInput = { ...bound, authorityPolicyHash: binding.securityPolicyHash };
        }
        const snapshot = await delegate.start(delegateInput);
        this.#assertOpen();
        const agentRef = snapshot?.agentRef;
        if (typeof agentRef !== "string" || !agentRef || agentRef.length > 512) {
          throw poolError("CODEX_ACCOUNT_BINDING_INVALID", "Account executor returned no valid agent reference; do not replay automatically");
        }
        const prior = this.#agentAccounts.get(agentRef);
        if (prior && prior !== selected.id) {
          throw poolError("CODEX_ACCOUNT_BINDING_INVALID", "Account executor returned an agent reference already bound to another account");
        }
        this.#agentAccounts.set(agentRef, selected.id);
        return this.#withAccount(snapshot, selected.id);
      } finally { this.#pendingStarts -= 1; }
    });
  }

  async show(input) { return this.#agentCall("show", input); }
  async send(input) { return this.#agentCall("send", input); }
  async steer(input) { return this.#agentCall("steer", input); }
  async cancel(input) { return this.#agentCall("cancel", input); }
  async resolveApproval(input) { return this.#agentCall("resolveApproval", input); }
  async resolvePendingRequest(input) { return this.#agentCall("resolvePendingRequest", input); }
  async rejectPendingRequest(input) { return this.#agentCall("rejectPendingRequest", input); }

  async #agentCall(method, input = {}) {
    this.#assertOpen();
    if (Object.hasOwn(input, "account")) throw poolError("CODEX_ACCOUNT_IMMUTABLE", "An existing agent cannot select or override its account");
    const bound = structuredClone(input);
    bound.clientRequestId = requestId(bound.clientRequestId);
    const selected = this.#accountForAgent(bound.agentRef);
    const safetyControl = isSafetyControl(method, bound);
    return this.#boundRequest(method, selected, bound, async () => {
      const delegate = await this.#delegateForAgentCall(selected, safetyControl);
      this.#assertOpen();
      const result = await delegate[method](bound);
      this.#assertOpen();
      return this.#withAccount(result, selected.id);
    });
  }

  #boundRequest(method, selected, input, execute) {
    const id = input.clientRequestId;
    const safetyControl = isSafetyControl(method, input);
    if (!id) return this.#track(execute, safetyControl);
    const hash = requestBindingHash(method, selected.id, input);
    const prior = this.#requestBindings.get(id);
    if (prior) {
      if (prior.requestHash !== hash) {
        throw poolError("CODEX_REQUEST_CONFLICT", "clientRequestId was already bound to a different Codex account, action, or control target");
      }
      if (prior.promise) return prior.promise.then((snapshot) => ({ ...structuredClone(snapshot), duplicate: true }));
      if (prior.error) throw poolError(prior.error.code, prior.error.message);
      return this.#track(async () => {
        const delegate = await this.#delegateForAgentCall(selected, safetyControl);
        this.#assertOpen();
        const snapshot = await delegate.show({ agentRef: prior.agentRef, afterSeq: 0 });
        return { ...this.#withAccount(snapshot, selected.id), duplicate: true,
          ...(prior.controlAcceptance ? { controlAcceptance: prior.controlAcceptance } : {}),
        };
      }, safetyControl);
    }
    const limit = this.#maxRequests + (safetyControl ? this.#maxAgents * 4 : 0);
    if (this.#requestBindings.size >= limit) {
      throw poolError("CODEX_ACCOUNT_CAPACITY", "Request capacity reached; new work is blocked without forgetting replay bindings");
    }
    const record = { requestHash: hash, promise: null, agentRef: null, error: null };
    const operation = this.#track(execute, safetyControl);
    record.promise = operation;
    this.#requestBindings.set(id, record);
    operation.then((snapshot) => {
      record.agentRef = snapshot?.agentRef ?? input.agentRef ?? null;
      record.controlAcceptance = snapshot?.controlAcceptance ?? null;
    }, (error) => {
      record.error = { code: typeof error?.code === "string" ? error.code : "CODEX_ACCOUNT_REQUEST_FAILED",
        message: (error instanceof Error ? error.message : String(error)).slice(0, 2_048) };
    }).finally(() => { record.promise = null; }).catch(() => {});
    return operation;
  }

  #accountForAgent(agentRef) {
    const id = this.#agentAccounts.get(agentRef);
    if (!id) throw poolError("CODEX_ACCOUNT_BINDING_UNKNOWN", "Unknown Codex account binding for agentRef");
    return resolveCodexAccount(this.#registry, id);
  }

  #withAccount(snapshot, account) {
    if (!snapshot || typeof snapshot !== "object") return snapshot;
    const copy = structuredClone(snapshot);
    return this.#registry.source === "legacy" ? copy : { ...copy, account };
  }

  #assertOpen() {
    if (this.#closed) throw new Error("CodexAccountAgentExecutor is closed");
  }

  #track(factory, safetyControl = false) {
    this.#assertOpen();
    if (this.#operations.size >= this.#maxInFlight + (safetyControl ? this.#maxAgents : 0)) {
      throw poolError("CODEX_ACCOUNT_CAPACITY", "Too many in-flight account operations");
    }
    const operation = Promise.resolve().then(() => { this.#assertOpen(); return factory(); });
    this.#operations.add(operation);
    operation.finally(() => this.#operations.delete(operation)).catch(() => {});
    return operation;
  }

  #quarantineAccount(accountId) {
    this.#cleanupFailures.set(accountId, true);
  }

  #assertAccountHealthy(account) {
    if (this.#cleanupFailures.has(account.id)) {
      throw poolError("CODEX_ACCOUNT_CLEANUP_FAILED", "Account runtime cleanup failed; automatic recreation is blocked");
    }
  }

  #providerCall(account, provider) {
    this.#assertOpen();
    this.#assertAccountHealthy(account);
    const prior = this.#providerPromises.get(account.id) ?? Promise.resolve();
    const operation = this.#track(async () => {
      await prior.catch(() => {});
      this.#assertOpen();
      this.#assertAccountHealthy(account);
      try {
        return await provider(account);
      } catch (error) {
        if (error?.code === "CODEX_ACCOUNT_CLEANUP_FAILED") {
          this.#quarantineAccount(account.id);
          throw poolError("CODEX_ACCOUNT_CLEANUP_FAILED", "Account telemetry cleanup failed; automatic recreation is blocked");
        }
        throw error;
      }
    });
    this.#providerPromises.set(account.id, operation);
    operation.finally(() => {
      if (this.#providerPromises.get(account.id) === operation) this.#providerPromises.delete(account.id);
    }).catch(() => {});
    return operation;
  }

  #hasAgentBindings(accountId) {
    for (const boundAccountId of this.#agentAccounts.values()) {
      if (boundAccountId === accountId) return true;
    }
    return false;
  }

  #runtimeLost(account) {
    return poolError(
      "CODEX_ACCOUNT_RUNTIME_LOST",
      `Codex account runtime for ${account.id} is no longer running; existing agent bindings cannot be recovered in-process`
    );
  }

  async #delegateForAgentCall(account, safetyControl = false) {
    if (safetyControl && this.#cleanupFailures.has(account.id)) {
      const existing = this.#delegates.get(account.id);
      if (existing?.running === true) return existing;
      throw poolError("CODEX_ACCOUNT_CLEANUP_FAILED", "Account runtime cleanup failed; no live existing executor remains for safety control");
    }
    return this.#delegate(account);
  }

  #dropAuthorityBindings(accountId) {
    for (const [leaseHash, binding] of this.#authorityBindings) {
      if (binding?.accountId === accountId) this.#authorityBindings.delete(leaseHash);
    }
  }

  async #delegate(account) {
    this.#assertOpen();
    this.#assertAccountHealthy(account);
    const existing = this.#delegates.get(account.id);
    if (existing?.running === true) return existing;

    let pending = this.#delegatePromises.get(account.id);
    if (!pending) {
      pending = (async () => {
        let delegate = this.#delegates.get(account.id) ?? null;
        if (delegate?.running === true) return delegate;
        if (delegate) {
          if (this.#hasAgentBindings(account.id)) throw this.#runtimeLost(account);
          try {
            await delegate.close();
          } catch {
            this.#quarantineAccount(account.id);
            throw poolError("CODEX_ACCOUNT_CLEANUP_FAILED", "Dead account App Server could not be closed; automatic recreation is blocked");
          }
          if (this.#delegates.get(account.id) === delegate) this.#delegates.delete(account.id);
          this.#delegateEpochs.delete(account.id);
          this.#dropAuthorityBindings(account.id);
          delegate = null;
        }
        try {
          delegate = await this.#factory(account, Object.freeze({
            assertHealthy: () => this.#assertAccountHealthy(account),
            quarantine: () => this.#quarantineAccount(account.id),
          }));
          if (!delegate || typeof delegate.open !== "function" || typeof delegate.close !== "function") {
            throw new Error("Delegate factory returned an invalid account executor");
          }
          this.#assertOpen();
          await delegate.open();
          this.#assertOpen();
          this.#assertAccountHealthy(account);
          if (delegate.running !== true) {
            throw new Error("Account executor did not report running after open");
          }
          this.#delegates.set(account.id, delegate);
          this.#delegateEpochs.set(account.id, randomUUID());
          this.#dropAuthorityBindings(account.id);
          return delegate;
        } catch (error) {
          if (delegate && typeof delegate.close === "function") {
            try { await delegate.close(); }
            catch {
              this.#quarantineAccount(account.id);
              throw poolError("CODEX_ACCOUNT_CLEANUP_FAILED", "Account App Server initialization and cleanup failed; automatic recreation is blocked");
            }
          }
          throw error;
        }
      })();
      this.#delegatePromises.set(account.id, pending);
    }
    try { return await pending; }
    finally { if (this.#delegatePromises.get(account.id) === pending) this.#delegatePromises.delete(account.id); }
  }
}
