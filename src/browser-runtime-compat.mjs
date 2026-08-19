import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function tomlString(value) {
  return JSON.stringify(String(value));
}

function pathForService(value) {
  return path.resolve(value).replaceAll("\\", "/");
}

function isPathWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function isRegularFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function readPluginManifest(versionRoot) {
  const manifestPath = path.join(versionRoot, ".codex-plugin", "plugin.json");
  try {
    const text = await readFile(manifestPath, "utf8");
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return { path: manifestPath, value };
  } catch {
    return null;
  }
}

function unavailable(reason, details = {}) {
  return {
    status: "unavailable",
    reason,
    source: "codex-skills-list",
    ...details,
    overrides: [],
  };
}

export function defaultBrowserRuntimeCwd({ env = process.env } = {}) {
  const override = typeof env?.CODEXLESS_BROWSER_RUNTIME_CWD === "string"
    ? env.CODEXLESS_BROWSER_RUNTIME_CWD.trim()
    : "";
  return path.resolve(override || os.homedir());
}

export async function resolveBrowserRuntimeCompatibility({ codexBin, chromeSkillPath, env = process.env, platform = process.platform } = {}) {
  if (typeof codexBin !== "string" || !codexBin.trim()) {
    throw new Error("resolveBrowserRuntimeCompatibility requires codexBin");
  }

  const browserRuntimeCwd = defaultBrowserRuntimeCwd({ env });
  if (typeof chromeSkillPath !== "string" || !chromeSkillPath.trim()) {
    return unavailable("current_chrome_skill_unavailable", { browserRuntimeCwd });
  }

  const codexHome = path.resolve(
    typeof env?.CODEX_HOME === "string" && env.CODEX_HOME.trim()
      ? env.CODEX_HOME
      : path.join(os.homedir(), ".codex")
  );
  const expectedBundleRoot = path.join(codexHome, "plugins", "cache", "openai-bundled");

  let bundleRoot;
  let skillPath;
  try {
    [bundleRoot, skillPath] = await Promise.all([
      realpath(expectedBundleRoot),
      realpath(path.resolve(chromeSkillPath)),
    ]);
  } catch {
    return unavailable("current_chrome_skill_path_untrusted", {
      chromeSkillPath: path.resolve(chromeSkillPath),
      browserRuntimeCwd,
    });
  }

  if (!isPathWithin(bundleRoot, skillPath)) {
    return unavailable("current_chrome_skill_path_untrusted", { chromeSkillPath: skillPath, browserRuntimeCwd });
  }

  const relativeSkillPath = path.relative(bundleRoot, skillPath);
  const segments = relativeSkillPath.split(path.sep).filter(Boolean);
  const [pluginName, build] = segments;
  if (pluginName?.toLowerCase() !== "chrome" || !build || segments.length < 3) {
    return unavailable("current_chrome_skill_path_untrusted", { chromeSkillPath: skillPath, browserRuntimeCwd });
  }

  const expectedChromeVersionRoot = path.join(bundleRoot, "chrome", build);
  const expectedBrowserVersionRoot = path.join(bundleRoot, "browser", build);
  let chromeVersionRoot;
  let browserVersionRoot;
  try {
    [chromeVersionRoot, browserVersionRoot] = await Promise.all([
      realpath(expectedChromeVersionRoot),
      realpath(expectedBrowserVersionRoot),
    ]);
  } catch {
    return unavailable("current_browser_plugin_pair_not_found", {
      build,
      chromeSkillPath: skillPath,
      browserRuntimeCwd,
    });
  }

  if (!isPathWithin(chromeVersionRoot, skillPath)) {
    return unavailable("current_chrome_skill_path_untrusted", { build, chromeSkillPath: skillPath, browserRuntimeCwd });
  }

  const [chromeManifest, browserManifest] = await Promise.all([
    readPluginManifest(chromeVersionRoot),
    readPluginManifest(browserVersionRoot),
  ]);
  if (
    !chromeManifest ||
    !browserManifest ||
    chromeManifest.value?.name !== "chrome" ||
    browserManifest.value?.name !== "browser" ||
    chromeManifest.value?.version !== build ||
    browserManifest.value?.version !== build
  ) {
    return unavailable("current_browser_plugin_manifest_mismatch", {
      build,
      chromeSkillPath: skillPath,
      browserRuntimeCwd,
    });
  }

  const expectedBrowserClientPath = path.join(chromeVersionRoot, "scripts", "browser-client.mjs");
  const expectedBrowserServicePath = path.join(browserVersionRoot, "scripts", "browser-service.mjs");
  const hasBrowserClient = await isRegularFile(expectedBrowserClientPath);
  const hasBrowserService = await isRegularFile(expectedBrowserServicePath);
  const allowStockBrowserService = platform === "darwin" && hasBrowserClient && !hasBrowserService;
  if (!hasBrowserClient || (!hasBrowserService && !allowStockBrowserService)) {
    return unavailable("current_browser_plugin_pair_not_found", {
      build,
      chromeSkillPath: skillPath,
      browserRuntimeCwd,
    });
  }

  let browserClientPath;
  let browserServicePath = null;
  try {
    browserClientPath = await realpath(expectedBrowserClientPath);
    if (hasBrowserService) browserServicePath = await realpath(expectedBrowserServicePath);
  } catch {
    return unavailable("current_browser_plugin_pair_not_found", {
      build,
      chromeSkillPath: skillPath,
      browserRuntimeCwd,
    });
  }

  if (
    !isPathWithin(chromeVersionRoot, browserClientPath) ||
    (browserServicePath !== null && !isPathWithin(browserVersionRoot, browserServicePath))
  ) {
    return unavailable("current_browser_plugin_path_escape", {
      build,
      chromeSkillPath: skillPath,
      browserRuntimeCwd,
    });
  }

  const browserClientSha256 = createHash("sha256")
    .update(await readFile(browserClientPath))
    .digest("hex");
  const resolvedCodexBin = path.resolve(codexBin);
  const overrides = [
    `mcp_servers.node_repl.env.BROWSER_USE_CODEX_APP_VERSION=${tomlString(build)}`,
    ...(browserServicePath === null ? [] : [
      `mcp_servers.node_repl.env.NODE_REPL_TRUSTED_SERVICES=${tomlString(JSON.stringify({
        browser: pathForService(browserServicePath),
        sky: "@oai/sky/service",
      }))}`,
    ]),
    `mcp_servers.node_repl.env.CODEX_CLI_PATH=${tomlString(resolvedCodexBin)}`,
    `shell_environment_policy.set.NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S=${tomlString(browserClientSha256)}`,
  ];

  return {
    status: "ok",
    source: "codex-skills-list",
    build,
    chromeSkillPath: skillPath,
    browserRuntimeCwd,
    browserServicePath,
    browserClientPath,
    browserClientSha256,
    chromeManifestPath: chromeManifest.path,
    browserManifestPath: browserManifest.path,
    serviceSource: browserServicePath === null ? "stock-node-repl" : "plugin-pair",
    overrides,
  };
}
