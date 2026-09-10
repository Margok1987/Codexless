import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { defaultCodexlessStateRoot } from "./runtime-routing-policy.mjs";

const ACCOUNT_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const ACCOUNT_HOME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const WINDOWS_RESERVED_HOME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function freezeRegistry(registry) {
  const accounts = Object.freeze(registry.accounts.map((entry) => Object.freeze({ ...entry })));
  return Object.freeze({ ...registry, accounts });
}

function accountError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function pathInside(base, target) {
  const relative = path.relative(base, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

export function defaultCodexAccountRegistryPath({ stateRoot = defaultCodexlessStateRoot() } = {}) {
  return path.join(path.resolve(stateRoot), "codex-accounts.json");
}

export async function loadCodexAccountRegistry({
  stateRoot = defaultCodexlessStateRoot(),
  filePath = null,
  legacyCodexHome = null,
} = {}) {
  const resolvedStateRoot = path.resolve(stateRoot);
  const resolvedFile = path.resolve(filePath ?? defaultCodexAccountRegistryPath({ stateRoot: resolvedStateRoot }));
  let source;
  let handle = null;
  try {
    handle = await open(resolvedFile, "r");
    const metadata = await handle.stat();
    const byteLimit = 64 * 1024;
    if (!metadata.isFile() || metadata.size > byteLimit) {
      throw accountError("CODEX_ACCOUNT_REGISTRY_INVALID", "Codex account registry must be a regular file of at most 64 KiB");
    }
    // The read is bounded even if the file grows after stat(). A file handle
    // also prevents a concurrent path replacement from mixing two snapshots.
    const buffer = Buffer.alloc(byteLimit + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const result = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
    }
    if (bytes > byteLimit) throw accountError("CODEX_ACCOUNT_REGISTRY_INVALID", "Codex account registry exceeds 64 KiB");
    source = buffer.subarray(0, bytes).toString("utf8");
  } catch (error) {
    if (error?.code === "ENOENT" && handle === null) {
      return freezeRegistry({
        schemaVersion: 1,
        source: "legacy",
        stateRoot: resolvedStateRoot,
        filePath: resolvedFile,
        accounts: [{ id: "default", codexHome: legacyCodexHome ? path.resolve(legacyCodexHome) : null }],
      });
    }
    if (error?.code === "CODEX_ACCOUNT_REGISTRY_INVALID") throw error;
    throw accountError("CODEX_ACCOUNT_REGISTRY_INVALID", "Codex account registry could not be read safely");
  } finally {
    if (handle) {
      try { await handle.close(); }
      catch { throw accountError("CODEX_ACCOUNT_REGISTRY_INVALID", "Codex account registry read could not be closed safely"); }
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    // JSON.parse errors can quote the input. Never expose registry fragments.
    throw accountError("CODEX_ACCOUNT_REGISTRY_INVALID", "Codex account registry is not valid JSON");
  }
  if (
    !parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || parsed.schemaVersion !== 1 || !Array.isArray(parsed.accounts)
    || parsed.accounts.length < 1 || parsed.accounts.length > 32
    || Object.keys(parsed).some((key) => !["schemaVersion", "accounts"].includes(key))
  ) {
    throw accountError("CODEX_ACCOUNT_REGISTRY_INVALID", "Codex account registry requires only schemaVersion 1 and 1..32 accounts");
  }

  const seen = new Set();
  const seenHomes = new Set();
  const accounts = parsed.accounts.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).some((key) => !["id", "home"].includes(key))) {
      throw accountError("CODEX_ACCOUNT_REGISTRY_INVALID", "each Codex account entry must contain only id and home");
    }
    const rawId = typeof entry.id === "string" ? entry.id : "";
    const rawHome = typeof entry.home === "string" ? entry.home : "";
    const id = rawId.trim();
    const home = rawHome.trim();
    if (rawId !== id || rawHome !== home) {
      throw accountError("CODEX_ACCOUNT_REGISTRY_INVALID", "Codex account id/home must not contain leading or trailing whitespace");
    }
    if (!ACCOUNT_ID_RE.test(id)) {
      throw accountError("CODEX_ACCOUNT_REGISTRY_INVALID", "invalid Codex account id");
    }
    if (seen.has(id)) throw accountError("CODEX_ACCOUNT_REGISTRY_INVALID", `duplicate Codex account id: ${id}`);
    seen.add(id);
    if (
      !ACCOUNT_HOME_RE.test(home)
      || path.basename(home) !== home
      || home === "."
      || home === ".."
      || /[ .]$/.test(home)
      || WINDOWS_RESERVED_HOME.test(home)
    ) {
      throw accountError("CODEX_ACCOUNT_REGISTRY_INVALID", `invalid Codex account home for ${id}`);
    }
    const codexHome = path.resolve(resolvedStateRoot, home);
    const homeKey = process.platform === "win32" ? codexHome.toLowerCase() : codexHome;
    if (seenHomes.has(homeKey)) {
      throw accountError("CODEX_ACCOUNT_REGISTRY_INVALID", `duplicate Codex account home: ${home}`);
    }
    seenHomes.add(homeKey);
    if (!pathInside(resolvedStateRoot, codexHome) || path.dirname(codexHome) !== resolvedStateRoot) {
      throw accountError("CODEX_ACCOUNT_REGISTRY_INVALID", `Codex account home escapes the state root for ${id}`);
    }
    return { id, codexHome };
  });

  return freezeRegistry({
    schemaVersion: 1,
    source: "registry",
    stateRoot: resolvedStateRoot,
    filePath: resolvedFile,
    accounts,
  });
}

export function resolveCodexAccount(registry, requestedAccount = null) {
  if (!registry || !Array.isArray(registry.accounts) || !registry.accounts.length) {
    throw accountError("CODEX_ACCOUNT_REGISTRY_INVALID", "Codex account registry is unavailable");
  }
  if (requestedAccount !== null && (typeof requestedAccount !== "string" || !ACCOUNT_ID_RE.test(requestedAccount))) {
    throw accountError("CODEX_ACCOUNT_INVALID", "account must be an exact valid configured account ID");
  }
  const requested = requestedAccount;
  if (!requested && registry.accounts.length > 1) {
    throw accountError(
      "CODEX_ACCOUNT_REQUIRED",
      `account is required when multiple Codex accounts are configured: ${registry.accounts.map((entry) => entry.id).join(", ")}`
    );
  }
  const id = requested ?? registry.accounts[0].id;
  const account = registry.accounts.find((entry) => entry.id === id);
  if (!account) {
    throw accountError(
      "CODEX_ACCOUNT_UNKNOWN",
      `unknown Codex account "${id}"; configured accounts: ${registry.accounts.map((entry) => entry.id).join(", ")}`
    );
  }
  return account;
}

export async function assertCodexAccountHome(account, { stateRoot, registry = null, allowMissing = false } = {}) {
  if (!account?.codexHome) return null;
  const resolvedStateRoot = path.resolve(stateRoot);
  const lexicalHome = path.resolve(account.codexHome);
  if (
    lexicalHome === resolvedStateRoot
    || !pathInside(resolvedStateRoot, lexicalHome)
    || path.dirname(lexicalHome) !== resolvedStateRoot
  ) {
    throw accountError("CODEX_ACCOUNT_HOME_UNSAFE", `Codex account home must be a direct child of the state root for ${account.id}`);
  }

  let realRoot;
  try {
    realRoot = await realpath(resolvedStateRoot);
  } catch (error) {
    throw accountError("CODEX_ACCOUNT_HOME_UNSAFE", "Codex state root cannot be resolved safely");
  }

  async function canonicalExistingHome(candidate, candidateId) {
    const lexical = path.resolve(candidate);
    try {
      const metadata = await lstat(lexical);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw accountError("CODEX_ACCOUNT_HOME_UNSAFE", `Codex account home must be a real directory, not a file, symlink, or junction for ${candidateId}`);
      }
      const canonical = await realpath(lexical);
      if (
        canonical === realRoot
        || !pathInside(realRoot, canonical)
        || path.dirname(canonical) !== realRoot
      ) {
        throw accountError("CODEX_ACCOUNT_HOME_UNSAFE", `Codex account home resolves outside the direct state-root children for ${candidateId}`);
      }
      // Inspect metadata only. Official file-based auth follows auth.json, so
      // separate directory names alone do not prevent credential aliasing.
      let authMetadata;
      try { authMetadata = await lstat(path.join(canonical, "auth.json")); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      if (authMetadata && (!authMetadata.isFile() || authMetadata.isSymbolicLink() || authMetadata.nlink !== 1)) {
        throw accountError("CODEX_ACCOUNT_HOME_UNSAFE", `Codex account auth state must be a regular, non-linked file for ${candidateId}`);
      }
      return canonical;
    } catch (error) {
      if (error?.code === "ENOENT" && allowMissing) return null;
      if (error?.code?.startsWith?.("CODEX_ACCOUNT_")) throw error;
      if (error?.code === "ENOENT") {
        throw accountError("CODEX_ACCOUNT_HOME_MISSING", `Codex account home is not provisioned for ${candidateId}`);
      }
      throw accountError("CODEX_ACCOUNT_HOME_UNSAFE", `Codex account home cannot be validated safely for ${candidateId}`);
    }
  }

  const realHome = await canonicalExistingHome(lexicalHome, account.id);
  if (!realHome) return lexicalHome;

  if (registry?.accounts) {
    const realKey = process.platform === "win32" ? realHome.toLowerCase() : realHome;
    for (const candidate of registry.accounts) {
      if (!candidate?.codexHome || candidate.id === account.id) continue;
      const other = await canonicalExistingHome(candidate.codexHome, candidate.id);
      if (!other) continue;
      const otherKey = process.platform === "win32" ? other.toLowerCase() : other;
      if (otherKey === realKey) {
        throw accountError(
          "CODEX_ACCOUNT_HOME_UNSAFE",
          `Codex accounts ${account.id} and ${candidate.id} resolve to the same physical CODEX_HOME`
        );
      }
    }
  }

  return realHome;
}