import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { resolveCodexExecutable } from "../src/codex-bin.mjs";

const require = createRequire(import.meta.url);
const { Client } = require("@modelcontextprotocol/client");
const { StdioClientTransport } = require("@modelcontextprotocol/client/stdio");

const projectRoot = path.resolve(import.meta.dirname, "..");
const codexBin = (await resolveCodexExecutable()).path;
const stateRoot = mkdtempSync(path.join(os.tmpdir(), "codexless-ssh-boundary-"));
const codexHome = path.join(stateRoot, "codex-home");
mkdirSync(codexHome, { recursive: true });
writeFileSync(
  path.join(codexHome, "config.toml"),
  `[projects.${JSON.stringify(projectRoot)}]\ntrust_level = "trusted"\n`,
  "utf8"
);

function isolatedEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CODEX_TOOLBOX_") || key.startsWith("CODEXLESS_")) delete env[key];
  }
  return {
    ...env,
    CODEX_BIN: codexBin,
    CODEX_HOME: codexHome,
    CODEXLESS_DEFAULT_CWD: projectRoot,
  };
}

const client = new Client({ name: "codexless-ssh-boundary", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(projectRoot, "src", "mcp-stdio-public.mjs")],
  cwd: projectRoot,
  env: isolatedEnv(),
  stderr: "pipe",
});

try {
  await client.connect(transport);
  const result = await client.callTool({
    name: "codex.command_exec",
    arguments: {
      command: [
        "ssh.exe",
        "user@host",
        "/usr/bin/python3",
        "-c",
        "print('hello world')",
      ],
      access: "readOnly",
      timeoutMs: 10000,
    },
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.errorCode, "NESTED_REMOTE_ARGV_UNSAFE");
  assert.equal(result.structuredContent?.reason, "remote-arg-requires-shell-quoting");
  assert.equal(result.structuredContent?.dispatch, "not_started");
  assert.equal(result.structuredContent?.effect, "none");
  assert.equal(result.structuredContent?.retryable, false);
  assert.match(result.content?.[0]?.text ?? "", /cannot guarantee remote argv boundaries/i);
  console.log("public command nested SSH tool-level guard PASS");
} finally {
  await client.close().catch(() => {});
  rmSync(stateRoot, { recursive: true, force: true });
}
