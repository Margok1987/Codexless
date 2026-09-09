function integerOrNull(value) {
  return Number.isInteger(value) ? value : null;
}

function normalizeBreakdown(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    inputTokens: integerOrNull(value.inputTokens),
    cachedInputTokens: integerOrNull(value.cachedInputTokens),
    cacheWriteInputTokens: integerOrNull(value.cacheWriteInputTokens),
    outputTokens: integerOrNull(value.outputTokens),
    reasoningOutputTokens: integerOrNull(value.reasoningOutputTokens),
    totalTokens: integerOrNull(value.totalTokens),
  };
}

export function normalizeThreadTokenUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    turn: normalizeBreakdown(value.last),
    threadTotal: normalizeBreakdown(value.total),
    modelContextWindow: integerOrNull(value.modelContextWindow),
  };
}

function projectError(error) {
  if (!error || typeof error !== "object") return null;
  return {
    // Upstream auth/transport diagnostics can contain account identifiers or
    // credential fragments. Keep structured status, never arbitrary text.
    name: "Unavailable",
    message: "Codex account telemetry is unavailable",
    rpcCode: Number.isInteger(error.rpcCode) ? error.rpcCode : null,
    rpcMessage: null,
  };
}

function projectLimit(limit) {
  const windows = Array.isArray(limit?.windows) ? limit.windows : [];
  return {
    // This projection reaches consent cards and terminal resource receipts too.
    // Bucket names/IDs are arbitrary upstream text, not safe display labels.
    key: limit?.key === "codex" ? "codex" : null,
    limitId: limit?.limitId === "codex" ? "codex" : null,
    limitName: ["Codex", "codex"].includes(limit?.limitName) ? limit.limitName : null,
    planType: ["free", "plus", "pro", "team", "business", "enterprise", "edu"].includes(limit?.planType) ? limit.planType : null,
    rateLimitReachedType: null,
    spendControlReached: typeof limit?.spendControlReached === "boolean" ? limit.spendControlReached : null,
    windows: windows.map((window) => ({
      kind: ["primary", "secondary"].includes(window?.kind) ? window.kind : null,
      usedPercent: Number.isInteger(window?.usedPercent) ? window.usedPercent : null,
      remainingPercent: Number.isInteger(window?.usedPercent) ? Math.max(0, Math.min(100, 100 - window.usedPercent)) : null,
      resetsAt: Number.isInteger(window?.resetsAt) ? window.resetsAt : null,
      windowDurationMins: Number.isInteger(window?.windowDurationMins) ? window.windowDurationMins : null,
    })),
  };
}

export function projectQuotaSnapshot(snapshot) {
  const rateLimits = snapshot?.rateLimits;
  const normalizedLimits = rateLimits?.status === "ok" && Array.isArray(rateLimits?.value?.limits)
    ? rateLimits.value.limits.map(projectLimit)
    : [];
  return {
    status: typeof snapshot?.status === "string" ? snapshot.status : "unavailable",
    observedAt: typeof snapshot?.observedAt === "string" ? snapshot.observedAt : null,
    rateLimits: {
      status: typeof rateLimits?.status === "string" ? rateLimits.status : "unavailable",
      limits: normalizedLimits,
      error: rateLimits?.status === "unavailable" ? projectError(rateLimits.error) : null,
    },
    usageTelemetry: {
      status: typeof snapshot?.usage?.status === "string" ? snapshot.usage.status : "unavailable",
      error: snapshot?.usage?.status === "unavailable" ? projectError(snapshot.usage.error) : null,
    },
  };
}

export function buildAgentResourceReceipt({ turnId, turnStatus, tokenUsage, quotaSnapshot, observedAt = new Date().toISOString() } = {}) {
  return {
    turnId: typeof turnId === "string" ? turnId : null,
    turnStatus: typeof turnStatus === "string" ? turnStatus : null,
    observedAt,
    tokenUsage: normalizeThreadTokenUsage(tokenUsage),
    accountQuota: projectQuotaSnapshot(quotaSnapshot),
    attribution: {
      taskTokenUsage: "Codex turn/thread telemetry for this formal Agent thread when available.",
      accountQuota: "Observed account waterline only; concurrent Codex/agentic work may also affect it.",
    },
  };
}
