import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CODEXLESS_GITHUB_API_BASE,
  buildDiscoveryFailureReceipt,
  discoverCodexlessRelease,
} from "./release-discovery.mjs";

export const AUTO_CHECK_STATE_VERSION = 1;
export const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const AUTO_CHECK_TIMEOUT_MS = 2_500;
export const AUTO_CHECK_STATE_FILE = path.join(os.homedir(), ".config", "codexless", "update-check.json");

const RELEASES_URL = `${CODEXLESS_GITHUB_API_BASE}/releases?per_page=100`;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export async function opportunisticCodexlessUpdateCheck({
  env = process.env,
  now = Date.now(),
  stateFile = AUTO_CHECK_STATE_FILE,
  currentRoot = null,
  metadataProbe = probeReleaseMetadata,
  discovery = discoverCodexlessRelease,
} = {}) {
  if (isDisabled(env)) return { checked: false, source: "disabled", network: false, advisory: null };

  const timestamp = normalizeNow(now);
  const intervalMs = positiveInteger(env.CODEXLESS_AUTO_CHECK_INTERVAL_MS, AUTO_CHECK_INTERVAL_MS);
  const timeoutMs = positiveInteger(env.CODEXLESS_AUTO_CHECK_TIMEOUT_MS, AUTO_CHECK_TIMEOUT_MS);
  const testEndpoint = resolveTestEndpoint(env);
  const previous = await readAutoCheckState(stateFile);
  const previousCheckedAt = Date.parse(previous?.lastCheckedAt ?? "");
  if (Number.isFinite(previousCheckedAt) && timestamp - previousCheckedAt >= 0 && timestamp - previousCheckedAt < intervalMs) {
    return buildResult(previous.cache, { checked: false, source: "cache", network: false });
  }

  let nextEtag = previous?.etag ?? null;
  let cache;
  try {
    const probe = await metadataProbe({
      etag: previous?.cache ? previous?.etag ?? null : null,
      timeoutMs,
      testEndpoint,
    });
    nextEtag = probe?.etag ?? nextEtag;
    if (probe?.notModified === true && previous?.cache) {
      cache = previous.cache;
    } else {
      try {
        const receipt = await discovery({
          currentRoot,
          downloadArtifact: false,
          timeoutMs,
          ...(testEndpoint ? { testEndpoint } : {}),
        });
        cache = normalizeDiscoveryReceipt(receipt);
      } catch (error) {
        cache = normalizeDiscoveryFailure(buildDiscoveryFailureReceipt(error));
      }
    }
  } catch (error) {
    cache = normalizeProbeFailure(error);
  }

  await writeAutoCheckState(stateFile, {
    stateVersion: AUTO_CHECK_STATE_VERSION,
    lastCheckedAt: new Date(timestamp).toISOString(),
    etag: normalizeEtag(nextEtag),
    cache,
  }).catch(() => {});
  return buildResult(cache, { checked: true, source: "network", network: true });
}

export async function readAutoCheckState(stateFile = AUTO_CHECK_STATE_FILE) {
  try {
    const parsed = JSON.parse(await readFile(path.resolve(stateFile), "utf8"));
    if (parsed?.stateVersion !== AUTO_CHECK_STATE_VERSION) return null;
    if (typeof parsed.lastCheckedAt !== "string" || !Number.isFinite(Date.parse(parsed.lastCheckedAt))) return null;
    return {
      stateVersion: AUTO_CHECK_STATE_VERSION,
      lastCheckedAt: parsed.lastCheckedAt,
      etag: normalizeEtag(parsed.etag),
      cache: normalizeStoredCache(parsed.cache),
    };
  } catch {
    return null;
  }
}

export async function probeReleaseMetadata({
  etag = null,
  timeoutMs = AUTO_CHECK_TIMEOUT_MS,
  testEndpoint = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") throw autoCheckError("fetch is unavailable", "NETWORK_OFFLINE");
  const endpoint = resolveNetworkEndpoint(testEndpoint);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, positiveInteger(timeoutMs, AUTO_CHECK_TIMEOUT_MS));
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "codexless-update-check/1",
    "X-GitHub-Api-Version": "2026-03-10",
  };
  if (etag) headers["If-None-Match"] = String(etag);
  let response;
  try {
    response = await fetchImpl(endpoint, { headers, redirect: "manual", signal: controller.signal });
  } catch (error) {
    if (timedOut || error?.name === "AbortError") throw autoCheckError("release metadata check timed out", "NETWORK_TIMEOUT");
    throw autoCheckError("release metadata check is offline", "NETWORK_OFFLINE");
  } finally {
    clearTimeout(timer);
  }

  const responseEtag = normalizeEtag(response.headers?.get?.("etag")) ?? normalizeEtag(etag);
  if (response.status === 304) {
    await cancelBody(response);
    return { notModified: true, etag: responseEtag };
  }
  if (response.status === 403 || response.status === 429) {
    await cancelBody(response);
    throw autoCheckError(`GitHub release check was rate limited (${response.status})`, "GITHUB_RATE_LIMIT");
  }
  if (response.status >= 300 && response.status < 400) {
    await cancelBody(response);
    throw autoCheckError("release metadata redirect is not accepted", "REDIRECT_REJECTED");
  }
  if (!response.ok) {
    await cancelBody(response);
    throw autoCheckError(`GitHub release check failed with HTTP ${response.status}`, "GITHUB_HTTP_ERROR");
  }
  await cancelBody(response);
  return { notModified: false, etag: responseEtag };
}

function normalizeDiscoveryReceipt(receipt) {
  return {
    status: String(receipt?.status ?? "unverified"),
    code: null,
    currentVersion: receipt?.current?.version ?? null,
    latestVersion: receipt?.latest?.version ?? null,
  };
}

function normalizeDiscoveryFailure(receipt) {
  const code = typeof receipt?.errorCode === "string" ? receipt.errorCode : "CHECK_FAILED";
  return {
    status: code === "NO_MATCHING_RELEASE" ? "unavailable" : "check_failed",
    code,
    currentVersion: null,
    latestVersion: null,
  };
}

function normalizeProbeFailure(error) {
  return {
    status: "check_failed",
    code: typeof error?.code === "string" ? error.code : "CHECK_FAILED",
    currentVersion: null,
    latestVersion: null,
  };
}

function normalizeStoredCache(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const allowed = new Set(["up_to_date", "update_available", "ahead", "unavailable", "check_failed", "unverified"]);
  return {
    status: allowed.has(value.status) ? value.status : "check_failed",
    code: typeof value.code === "string" ? value.code : null,
    currentVersion: typeof value.currentVersion === "string" ? value.currentVersion : null,
    latestVersion: typeof value.latestVersion === "string" ? value.latestVersion : null,
  };
}

function buildResult(cache, { checked, source, network }) {
  const normalized = normalizeStoredCache(cache) ?? normalizeProbeFailure({ code: "CHECK_FAILED" });
  return {
    checked: Boolean(checked),
    source,
    network: Boolean(network),
    status: normalized.status,
    code: normalized.code,
    advisory: normalized.status === "update_available"
      ? {
          status: "update_available",
          currentVersion: normalized.currentVersion,
          latestVersion: normalized.latestVersion,
        }
      : null,
  };
}

async function writeAutoCheckState(stateFile, state) {
  const target = path.resolve(stateFile);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function resolveTestEndpoint(env) {
  if (env.CODEXLESS_AUTO_CHECK_TEST_MODE !== "1") return null;
  const value = env.CODEXLESS_AUTO_CHECK_TEST_ENDPOINT;
  if (typeof value !== "string" || !value.trim()) throw autoCheckError("auto-check test endpoint is required in test mode", "TEST_ENDPOINT_INVALID");
  const url = new URL(value.trim());
  if (!LOOPBACK_HOSTS.has(url.hostname)) throw autoCheckError("auto-check test endpoint must be loopback", "TEST_ENDPOINT_REJECTED");
  return url.toString();
}

function resolveNetworkEndpoint(testEndpoint) {
  if (!testEndpoint) return RELEASES_URL;
  const url = new URL(testEndpoint);
  if (!LOOPBACK_HOSTS.has(url.hostname)) throw autoCheckError("auto-check test endpoint must be loopback", "TEST_ENDPOINT_REJECTED");
  return url.toString();
}

function isDisabled(env) {
  if (env.CODEXLESS_AUTO_CHECK_DISABLED === "1") return true;
  const value = String(env.CODEXLESS_AUTO_CHECK ?? "on").trim().toLowerCase();
  return new Set(["0", "false", "off", "disabled"]).has(value);
}

function normalizeEtag(value) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 512) : null;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeNow(value) {
  const number = typeof value === "function" ? Number(value()) : Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error("now must be a finite epoch-millisecond value");
  return number;
}

function autoCheckError(message, code) {
  const error = new Error(message);
  error.name = "AutoCheckError";
  error.code = code;
  return error;
}

async function cancelBody(response) {
  if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
}
