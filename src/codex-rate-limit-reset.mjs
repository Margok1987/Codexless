import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const READ_METHOD = "account/rateLimits/read";
const CONSUME_METHOD = "account/rateLimitResetCredit/consume";

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

export function assertResetChatgptAccount(response) {
  if (response?.account?.type !== "chatgpt") {
    throw failure("CODEX_RESET_CHATGPT_AUTH_REQUIRED", "Banked resets require the selected managed account to be logged in with ChatGPT");
  }
}

export async function verifyResetChatgptAccount(client) {
  if (!client || typeof client.request !== "function") throw new Error("Reset identity check requires a native App Server client");
  const response = await client.request("account/read", { refreshToken: false });
  assertResetChatgptAccount(response);
}

function selectCredit(snapshot, nowMs) {
  const limits = snapshot?.rateLimitsByLimitId?.codex ?? snapshot?.rateLimits ?? null;
  if (![limits?.primary, limits?.secondary].some((window) =>
    Number.isInteger(window?.usedPercent) && window.usedPercent >= 100)) {
    throw failure("CODEX_RESET_NOT_NEEDED", "No exhausted Codex quota window is eligible for a banked reset");
  }
  const summary = snapshot?.rateLimitResetCredits;
  if (!summary || !Number.isSafeInteger(summary.availableCount) || summary.availableCount < 0) {
    throw failure("CODEX_RESET_CREDIT_DETAILS_UNAVAILABLE", "A complete native credit snapshot is required");
  }
  if (summary.availableCount === 0) throw failure("CODEX_RESET_NO_CREDIT", "There is no banked reset credit available");
  if (!Array.isArray(summary.credits) || summary.credits.length < summary.availableCount) {
    throw failure("CODEX_RESET_CREDIT_DETAILS_INCOMPLETE", "Native credit details are missing or capped; no credit can be selected safely");
  }
  const available = summary.credits.filter((credit) => credit?.status === "available");
  if (available.length !== summary.availableCount || available.some((credit) =>
    credit.resetType !== "codexRateLimits"
    || typeof credit.id !== "string" || !credit.id || credit.id.length > 256
    || !Number.isSafeInteger(credit.expiresAt) || credit.expiresAt * 1000 <= nowMs
  )) {
    throw failure("CODEX_RESET_CREDIT_AMBIGUOUS", "Available credits do not have complete, eligible identities and expiry dates");
  }
  available.sort((a, b) => a.expiresAt - b.expiresAt);
  if (available.length > 1 && available[0].expiresAt === available[1].expiresAt) {
    throw failure("CODEX_RESET_CREDIT_AMBIGUOUS", "The two earliest reset credits have the same expiry");
  }
  const credit = available[0];
  return {
    creditId: credit.id,
    expiresAt: credit.expiresAt,
    availableCount: summary.availableCount,
    providerAccountId: typeof snapshot.accountId === "string" ? snapshot.accountId : null,
    rateLimits: limits,
  };
}

function quotaMoved(before, after) {
  for (const part of ["primary", "secondary"]) {
    const a = before?.[part];
    const b = after?.[part];
    if (Number.isFinite(a?.usedPercent) && a.usedPercent > 0
      && Number.isFinite(b?.usedPercent) && b.usedPercent < a.usedPercent
      && Number.isFinite(a?.resetsAt) && Number.isFinite(b?.resetsAt) && b.resetsAt > a.resetsAt) {
      return true;
    }
  }
  return false;
}

function persistentCreditGuard(lockRoot) {
  if (typeof lockRoot !== "string" || !path.isAbsolute(lockRoot)) {
    throw new Error("A persistent owner-controlled Codexless state root is required for reset consumption");
  }
  const directory = path.join(lockRoot, "banked-reset-guards");

  function filename(account) { return path.join(directory, `account-${account}.json`); }
  function inspect(account) {
    const name = filename(account);
    let stat;
    try { stat = fs.lstatSync(name); }
    catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw failure("CODEX_RESET_GUARD_INVALID", "Persistent reset record is not a regular file");
    }
    throw failure("CODEX_RESET_RECONCILIATION_REQUIRED",
      "A previous reset may have been dispatched. Reconcile its native result before new consumption");
  }
  function begin({ account, taskId, creditId, availableCount, createdAt }) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    inspect(account);
    const record = {
      schemaVersion: 1,
      account,
      taskId,
      creditDigest: createHash("sha256").update(creditId).digest("hex"),
      beforeAvailableCount: availableCount,
      preparedAt: createdAt,
      state: "dispatch_may_have_started",
    };
    let descriptor;
    try { descriptor = fs.openSync(filename(account), "wx", 0o600); }
    catch (error) {
      if (error?.code === "EEXIST") {
        throw failure("CODEX_RESET_RECONCILIATION_REQUIRED", "Unresolved reset marker blocks a new dispatch");
      }
      throw error;
    }
    try {
      fs.writeFileSync(descriptor, JSON.stringify(record) + "\n", "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }
  function release(account) {
    const name = filename(account);
    if (!fs.lstatSync(name).isFile()) throw failure("CODEX_RESET_GUARD_INVALID", "Persistent reset record changed");
    fs.unlinkSync(name);
  }
  return Object.freeze({ inspect, begin, release });
}

// Pending consent lives only in this runtime generation; uncertain dispatch survives restart.
export function createCodexRateLimitResetCoordinator({ request, now = Date.now, newId = randomUUID, lockRoot, maxTasks = 1_000 } = {}) {
  if (typeof request !== "function") throw new Error("Reset coordinator requires a selected-account native App Server request function");
  if (typeof now !== "function" || typeof newId !== "function") throw new Error("Invalid reset clock or ID generator");
  const tasks = new Map();
  const guard = persistentCreditGuard(lockRoot);

  async function prepare({ account } = {}) {
    if (typeof account !== "string" || !/^[a-zA-Z0-9_-]{1,32}$/.test(account)) {
      throw failure("CODEX_RESET_ACCOUNT_REQUIRED", "Select one exact managed Codex account");
    }
    guard.inspect(account);
    if (tasks.size >= maxTasks) throw failure("CODEX_RESET_CAPACITY", "Reset task capacity reached");
    if ([...tasks.values()].some((task) => task.account === account && ["pending", "verifying", "dispatching", "unknown_outcome"].includes(task.state))) {
      throw failure("CODEX_RESET_PENDING", "A pending or uncertain reset exists for this account; reconcile it first");
    }
    const selected = selectCredit(await request({ account, method: READ_METHOD, params: null }), now());
    const uuid = newId();
    if (typeof uuid !== "string" || !/^[a-fA-F0-9-]{32,36}$/.test(uuid)) throw new Error("Reset UUID generator failed");
    const taskId = `R-${uuid.replace(/-/g, "").toUpperCase()}`;
    if (tasks.has(taskId)) throw failure("CODEX_RESET_TASK_CONFLICT", "Reset task identifier collision");
    const task = { account, taskId, idempotencyKey: uuid, selected, state: "pending", createdAt: now(), result: null };
    tasks.set(taskId, task);
    const expiry = new Date(selected.expiresAt * 1000).toISOString();
    const text = [
      "⚠️ **Banked Codex Reset freigeben?**",
      `Konto: **${account}**`,
      `Verfügbare Credits: **${selected.availableCount}**`,
      `Ausgewählter Credit verfällt: **${expiry}**`,
      "Wirkung: Genau einen gespeicherten Reset-Credit unwiderruflich verbrauchen.",
      `Task ID: **${taskId}**`,
      "Bitte mit **Yes** oder **No** antworten.",
    ].join("\n");
    return { status: "consent_required", taskId, account, credit: { expiresAt: selected.expiresAt },
      availableCount: selected.availableCount, expiresAt: task.createdAt + 10 * 60_000,
      chatPresentation: { text, approveTool: "codex.reset_credit_decide", declineTool: "codex.reset_credit_decide" } };
  }

  async function decide({ taskId, decision } = {}) {
    if (typeof taskId !== "string" || !/^R-[A-F0-9]{32}$/.test(taskId)) {
      throw failure("CODEX_RESET_TASK_UNKNOWN", "Unknown reset approval Task ID");
    }
    const task = tasks.get(taskId);
    if (!task) throw failure("CODEX_RESET_TASK_UNKNOWN", "Reset Task ID is missing or belongs to another runtime generation");
    if (task.result) return { ...structuredClone(task.result), duplicate: true };
    if (task.state !== "pending") return { status: task.state, taskId, account: task.account, duplicate: true };
    if (now() > task.createdAt + 10 * 60_000) {
      task.state = "expired";
      task.result = { status: "expired", taskId, account: task.account, effect: "none" };
      return task.result;
    }
    if (decision === "decline") {
      task.state = "declined";
      task.result = { status: "declined", taskId, account: task.account, effect: "none" };
      return task.result;
    }
    if (decision !== "commit") throw failure("CODEX_RESET_DECISION_REQUIRED", "Decision must be commit or decline");

    // Lock synchronously before the first await: no parallel commit or decline may dispatch.
    task.state = "verifying";
    let current;
    try {
      current = selectCredit(await request({ account: task.account, method: READ_METHOD, params: null }), now());
    } catch {
      task.state = "blocked";
      task.result = { status: "blocked", taskId, account: task.account, effect: "none", reason: "fresh_native_preflight_failed" };
      return task.result;
    }
    const before = task.selected;
    if (current.creditId !== before.creditId || current.availableCount !== before.availableCount
      || current.expiresAt !== before.expiresAt || current.providerAccountId !== before.providerAccountId) {
      task.state = "blocked";
      task.result = { status: "blocked", taskId, account: task.account, effect: "none", reason: "stale_or_changed_credit_prestate" };
      return task.result;
    }

    try {
      guard.begin({
        account: task.account,
        taskId,
        creditId: before.creditId,
        availableCount: before.availableCount,
        createdAt: task.createdAt,
      });
    } catch {
      task.state = "blocked";
      task.result = { status: "blocked", taskId, account: task.account, effect: "none",
        reason: "persistent_dispatch_guard_unavailable_or_unresolved" };
      return task.result;
    }

    task.state = "dispatching";
    let nativeResult;
    try {
      nativeResult = await request({ account: task.account, method: CONSUME_METHOD,
        params: { idempotencyKey: task.idempotencyKey, creditId: before.creditId } });
    } catch {
      task.state = "unknown_outcome";
      task.result = { status: "unknown_outcome", taskId, account: task.account, effect: "unknown",
        reason: "native_consume_acceptance_unknown_no_retry" };
      return task.result;
    }

    const outcome = nativeResult?.outcome;
    if (!["reset", "alreadyRedeemed", "nothingToReset", "noCredit"].includes(outcome)) {
      task.state = "unknown_outcome";
      task.result = { status: "unknown_outcome", taskId, account: task.account, effect: "unknown",
        reason: "unexpected_native_outcome_no_retry" };
      return task.result;
    }
    if (outcome === "nothingToReset" || outcome === "noCredit") {
      try { guard.release(task.account); }
      catch {
        task.state = "unknown_outcome";
        task.result = { status: "unknown_outcome", taskId, account: task.account, outcome,
          effect: "none", reason: "native_no_effect_but_persistent_guard_not_cleared" };
        return task.result;
      }
      task.state = "not_applied";
      task.result = { status: "not_applied", taskId, account: task.account, outcome, effect: "none" };
      return task.result;
    }

    try {
      const after = await request({ account: task.account, method: READ_METHOD, params: null });
      const credits = after?.rateLimitResetCredits;
      const countVerified = Number.isSafeInteger(credits?.availableCount)
        && credits.availableCount === before.availableCount - 1
        && Array.isArray(credits.credits)
        && !credits.credits.some((c) => c?.id === before.creditId && c?.status === "available");
      const quotaVerified = quotaMoved(before.rateLimits, after?.rateLimits);
      const providerVerified = countVerified && quotaVerified;
      let guardCleared = false;
      if (providerVerified) {
        try { guard.release(task.account); guardCleared = true; }
        catch { /* Keep the persistent guard and fail closed until reconciled. */ }
      }
      task.state = providerVerified && guardCleared ? "verified" : "unknown_outcome";
      task.result = { status: task.state, taskId, account: task.account, outcome,
        effect: providerVerified ? "applied" : "possibly_applied",
        verification: { creditCount: countVerified, quotaWindows: quotaVerified, persistentGuardCleared: guardCleared },
        availableCount: Number.isSafeInteger(credits?.availableCount) ? credits.availableCount : null };
    } catch {
      task.state = "unknown_outcome";
      task.result = { status: "unknown_outcome", taskId, account: task.account, outcome,
        effect: "possibly_applied", reason: "native_readback_failed_no_retry" };
    }
    return task.result;
  }

  return Object.freeze({ prepare, decide });
}

function response(value, isError = false) {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text", text: value?.chatPresentation?.text ?? JSON.stringify(value) }],
    structuredContent: value,
  };
}

export function registerCodexRateLimitResetTools(server, coordinator, z) {
  if (!coordinator) return;
  if (!z || typeof z.object !== "function") throw new Error("Reset MCP schema dependency is required");
  server.registerTool("codex.reset_credit_prepare", {
    title: "Prepare one banked Codex reset",
    description: "READ/PREPARE only. Select one exact managed account, read native Codex reset-credit details and prepare one irrevocable reset bound to a server-generated Task ID. NO credit is consumed. Present the returned chatPresentation.text verbatim to the Owner, then call codex.reset_credit_decide only after their literal Yes/No reply. Do not retry a platform safety block.",
    inputSchema: z.object({ account: z.string().min(1).max(32) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ account }) => {
    try { return response(await coordinator.prepare({ account })); }
    catch (error) { return response({ status: "blocked", effect: "none", errorCode: error?.code ?? "CODEX_RESET_PREPARE_UNAVAILABLE" }, true); }
  });
  server.registerTool("codex.reset_credit_decide", {
    title: "Decide one exact banked Codex reset",
    description: "Commit or decline only the exact server-prepared Task ID after an explicit Owner Yes/No decision. commit is irreversible and uses a single native App Server consume request bound to a selected credit and idempotency key; any unknown outcome is NOT retried. Never call commit automatically and never treat technical access as Owner approval.",
    inputSchema: z.object({ taskId: z.string().min(1).max(64), decision: z.enum(["commit", "decline"]) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (input) => {
    try { return response(await coordinator.decide(input)); }
    catch (error) { return response({ status: "blocked", effect: "none", errorCode: error?.code ?? "CODEX_RESET_DECISION_UNAVAILABLE" }, true); }
  });
}
