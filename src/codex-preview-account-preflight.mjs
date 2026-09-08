import path from "node:path";
import { CodexAppServerClient } from "./codex-app-server-client.mjs";
import { readCodexQuotaSnapshot } from "./codex-quota-snapshot.mjs";

const ACCOUNT_READ_METHOD = "account/read";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeError(error) {
  const rpcError = isRecord(error?.rpcError) ? error.rpcError : null;
  const directRpcCode = Number.isInteger(error?.rpcCode) ? error.rpcCode : null;
  return {
    // Authentication and transport diagnostics can contain account identifiers,
    // URLs, or credential fragments. Public preflight keeps only safe structure.
    name: "Unavailable",
    message: "Codex account telemetry is unavailable; upstream diagnostics are withheld",
    rpcCode: Number.isInteger(rpcError?.code) ? rpcError.code : directRpcCode,
    rpcMessage: null,
  };
}

function unavailableAccount(error) {
  return {
    status: "unavailable",
    method: ACCOUNT_READ_METHOD,
    accountPresent: null,
    authMode: null,
    requiresOpenaiAuth: null,
    plan: null,
    error: normalizeError(error),
  };
}

function normalizeAccount(response) {
  const source = isRecord(response) ? response : {};
  const account = isRecord(source.account) ? source.account : null;
  return {
    status: "ok",
    method: ACCOUNT_READ_METHOD,
    accountPresent: Boolean(account),
    authMode: typeof account?.type === "string" ? account.type : typeof source.authMode === "string" ? source.authMode : null,
    requiresOpenaiAuth: typeof source.requiresOpenaiAuth === "boolean" ? source.requiresOpenaiAuth : null,
    plan: typeof account?.planType === "string" ? account.planType : null,
    error: null,
  };
}

function safeLimitKey(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(value) ? value : null;
}

function projectRateLimitWindows(entry) {
  if (entry?.status !== "ok" || !Array.isArray(entry?.value?.limits)) return [];
  const windows = [];
  for (const limit of entry.value.limits) {
    for (const window of Array.isArray(limit?.windows) ? limit.windows : []) {
      if (!Number.isInteger(window?.usedPercent)) continue;
      windows.push({
        limitKey: safeLimitKey(limit?.key),
        kind: window?.kind === "primary" || window?.kind === "secondary" ? window.kind : null,
        remainingPercent: Math.max(0, Math.min(100, 100 - window.usedPercent)),
        resetsAt: Number.isInteger(window?.resetsAt) ? window.resetsAt : null,
        windowDurationMins: Number.isInteger(window?.windowDurationMins) ? window.windowDurationMins : null,
      });
    }
  }
  return windows;
}

function projectQuotaEntry(entry, { includeWindows = false } = {}) {
  return {
    status: entry?.status ?? "unavailable",
    ...(includeWindows ? { windows: projectRateLimitWindows(entry) } : {}),
    error: entry?.status === "unavailable" && entry?.error ? normalizeError(entry.error) : null,
  };
}

function normalizeQuota(snapshot) {
  return {
    status: snapshot?.status ?? "unavailable",
    observedAt: typeof snapshot?.observedAt === "string" ? snapshot.observedAt : null,
    usage: projectQuotaEntry(snapshot?.usage),
    rateLimits: projectQuotaEntry(snapshot?.rateLimits, { includeWindows: true }),
  };
}

function unavailableQuota(error, now) {
  const normalized = normalizeError(error);
  return {
    status: "unavailable",
    observedAt: new Date(now()).toISOString(),
    usage: { status: "unavailable", error: normalized },
    rateLimits: { status: "unavailable", windows: [], error: normalized },
  };
}

async function closeTelemetryClient(client) {
  if (!client || typeof client.close !== "function") {
    return { status: "not-started", error: null };
  }
  try {
    await client.close();
    return { status: "ok", error: null };
  } catch {
    throw Object.assign(
      new Error("Codex account telemetry cleanup failed; upstream diagnostics are withheld"),
      { code: "CODEX_ACCOUNT_CLEANUP_FAILED" }
    );
  }
}

export function createPreviewTelemetryClient({ codexBin, defaultCwd, configOverrides = [], launchEnv = null, stderrHandler = null } = {}) {
  if (!codexBin) throw new Error("createPreviewTelemetryClient requires codexBin");
  if (!defaultCwd) throw new Error("createPreviewTelemetryClient requires defaultCwd");
  if (!Array.isArray(configOverrides) || !configOverrides.every((value) => typeof value === "string" && value.trim())) {
    throw new Error("configOverrides must be an array of non-empty strings");
  }
  if (launchEnv !== null && (typeof launchEnv !== "object" || Array.isArray(launchEnv))) {
    throw new Error("launchEnv must be null or an environment object");
  }

  const cwd = path.resolve(defaultCwd);
  return new CodexAppServerClient({
    cwd,
    launch: () => ({
      command: codexBin,
      args: [
        ...configOverrides.flatMap((value) => ["-c", value]),
        "app-server",
        "--stdio",
      ],
      options: { cwd, ...(launchEnv ? { env: launchEnv } : {}) },
    }),
    requestTimeoutMs: 10_000,
    initializeCapabilities: { experimentalApi: true },
    stderrHandler,
    clientInfo: {
      name: "codex_toolbox_preview_account_preflight",
      title: "Codex Toolbox Preview Account Preflight",
      version: "0.0.1",
    },
  });
}

export async function readPreviewAccountPreflight({
  codexBin,
  defaultCwd,
  configOverrides = [],
  launchEnv = null,
  clientFactory = createPreviewTelemetryClient,
  now = Date.now,
} = {}) {
  if (typeof clientFactory !== "function") throw new Error("clientFactory must be a function");
  if (typeof now !== "function") throw new Error("now must be a function");

  const observedAt = new Date(now()).toISOString();
  let client = null;
  let account;
  let quota;

  try {
    client = clientFactory({ codexBin, defaultCwd, configOverrides, launchEnv });
    await client.start();
  } catch (error) {
    return {
      status: "unavailable",
      observedAt,
      account: unavailableAccount(error),
      quota: unavailableQuota(error, now),
      cleanup: await closeTelemetryClient(client),
    };
  }

  try {
    account = normalizeAccount(await client.request(ACCOUNT_READ_METHOD, { refreshToken: false }));
  } catch (error) {
    account = unavailableAccount(error);
  }

  try {
    quota = normalizeQuota(await readCodexQuotaSnapshot({ client, now }));
  } catch (error) {
    quota = unavailableQuota(error, now);
  }

  const cleanup = await closeTelemetryClient(client);
  const observedCount = [
    account.status === "ok",
    quota.status !== "unavailable",
  ].filter(Boolean).length;
  const dataStatus = observedCount === 2 ? "ok" : observedCount === 1 ? "partial" : "unavailable";

  return {
    status: cleanup.status === "ok" ? dataStatus : dataStatus === "unavailable" ? "unavailable" : "partial",
    observedAt,
    account,
    quota,
    cleanup,
  };
}