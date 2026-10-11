import assert from "node:assert/strict";
import { assertNoNestedCodexInvocation, nestedCodexInvocationReason, nestedSshRemoteArgvRisk } from "../src/public-command-policy.mjs";

const configuredWindowsCodex = "C:\\Pinned\\codex.exe";

const blocked = [
  [["codex", "--version"], "direct-codex-executable"],
  [["C:\\Pinned\\codex.exe", "exec", "probe"], "direct-codex-executable"],
  [["cmd.exe", "/d", "/s", "/c", "codex exec probe"], "codex-via-cmd"],
  [["powershell.exe", "-NoProfile", "-Command", "& 'C:\\Pinned\\codex.exe' exec probe"], "codex-via-powershell"],
  [["bash", "-lc", "/Applications/ChatGPT.app/Contents/Resources/codex exec probe"], "codex-via-bash"],
  [["node", "-e", "require('node:child_process').spawnSync('codex',['exec','probe'])"], "codex-via-node"],
  [["node", "-p", "require('node:child_process').spawnSync('codex',['exec','probe'])"], "codex-via-node"],
  [["node", "--print", "require('node:child_process').spawnSync('codex',['exec','probe'])"], "codex-via-node"],
  [["deno", "eval", "new Deno.Command('codex',{args:['exec','probe']}).outputSync()"], "codex-via-deno"],
  [["python3", "-c", "import subprocess; subprocess.run(['codex','exec','probe'])"], "codex-via-python3"],
  [["sudo", "codex", "exec", "probe"], "codex-via-sudo"],
  [["wsl.exe", "codex", "exec", "probe"], "codex-via-wsl"],
  [["npx", "codex", "exec", "probe"], "codex-via-npx"],
  [["env", "codex", "exec", "probe"], "codex-via-env"],
  [["node", "-e", "const c = 'codex'; require('node:child_process').spawnSync(c, ['exec', 'probe'])"], "codex-via-node"],
  [["node", "-e", "const {execSync: run} = require('child_process'); run('codex exec probe')"], "codex-via-node"],
  [["node", "-e", "import {execSync} from 'node:child_process'; execSync('codex exec probe')"], "codex-via-node"],
  [["node", "-e", "const cp = require('node:child_process'); const run = cp.execSync; run('codex exec probe')"], "codex-via-node"],
  [["node", "-e", "const cp = require('node:child_process'); let run = cp.execSync; run('codex exec probe')"], "codex-via-node"],
  [["node", "-e", "require('child_process')['spawn' + 'Sync']('codex', ['exec'])"], "codex-via-node"],
  [["node", "-e", "require('child_process').spawnSync('co' + 'dex', ['exec'])"], "codex-via-node"],
  [["node", "-e", String.raw`require('child_process').spawnSync('co\u0064ex', ['exec'])`], "codex-via-node"],
  [["node", "-e", "require('child_process').spawnSync('node', ['-e', \"require('child_process').execSync('codex exec probe')\"])"], "codex-via-node"],
  [["node", "--eval=require('child_process').execSync('codex exec probe')"], "codex-via-node"],
  [["node", "--print=require('child_process').execSync('codex exec probe')"], "codex-via-node"],
  [["node", "-e", "await import('@openai/codex')"], "codex-via-node"],
  [["node", "-e", "require('@openai/codex')"], "codex-via-node"],
  [["node", "-e", "const value='Codex'; eval(value)"], "codex-via-node"],
  [["node", "-e", "new Function(\"require('child_process').execSync('codex exec probe')\")()"], "codex-via-node"],
  [["node", "-e", "const data='codex'; require(moduleName).run(data)"], "codex-via-node"],
  [["node", "-e", "const data='Codex'; process.getBuiltinModule('child_process').spawnSync(data,[])"], "codex-via-node"],
  [["node", "-e", "const data='codex'; ({}).constructor.constructor(data)()"], "codex-via-node"],
  [["node", "-e", "const data='codex'; require('child_process')[method](data)"], "codex-via-node"],
  [["node", "-e", "const broken = 'Codex'; {"], "codex-via-node"],
  [["node", "-e", "const c='codex'; require('child_process').spawnSync(c, args)"], "codex-via-node"],
  [["node", "-e", "const cp=require('child_process'); Reflect.apply(cp.execSync,null,['codex exec probe'])"], "codex-via-node"],
  [["node", "-e", "require('child_process').execSync.call(null,'codex exec probe')"], "codex-via-node"],
  [["node", "-e", "require('child_process').execSync.bind(null,'codex exec probe')()"], "codex-via-node"],
  [["node", "-e", "const run=()=>require('child_process').execSync('codex exec probe'); run()"], "codex-via-node"],
  [["node", "-e", "const run=function(c){require('child_process').spawnSync(c,[])}; run('codex')"], "codex-via-node"],
  [["node", "-e", "const run=(fn)=>fn('codex exec probe'); run(require('child_process').execSync)"], "codex-via-node"],
];

for (const [command, reason] of blocked) {
  assert.equal(nestedCodexInvocationReason(command, { codexBin: configuredWindowsCodex }), reason, JSON.stringify(command));
  assert.throws(
    () => assertNoNestedCodexInvocation(command, { codexBin: configuredWindowsCodex }),
    (error) => error?.code === "METERED_CODEX_REQUIRES_AGENT_CARD" && /codex\.agent_start/.test(error?.message ?? ""),
    JSON.stringify(command)
  );
}

const allowed = [
  ["rg", "codex", "src"],
  ["git", "grep", "codex"],
  ["where.exe", "codex"],
  ["which", "codex"],
  ["node", "test/public-contract.mjs"],
  ["node", "-p", "1 + 1"],
  ["deno", "eval", "console.log('codexless')"],
  ["sudo", "echo", "ok"],
  ["wsl.exe", "echo", "ok"],
  ["npm", "test"],
  ["cmd.exe", "/d", "/s", "/c", "echo codexless"],
  ["powershell.exe", "-NoProfile", "-Command", "Write-Output 'codexless'"],
  ["node", "-e", "const data={description:'Read Codex data',dependencies:{'@openai/codex':'0.153.4'}}; process.stdout.write(JSON.stringify(data))"],
  ["node", "-e", "console.log('Codex')"],
  ["node", "-p", "({ dependency: '@openai/codex' })"],
  ["node", "--eval=console.log('Codex')"],
  ["node", "--print=JSON.stringify({name:'Codex'})"],
  ["node", "-e", "const data=`Codex`; console.log(data)"],
  ["node", "-e", "// Codex is a comment\nconsole.log(1)"],
  ["node", "-e", "/* @openai/codex */ console.log(1)"],
  ["node", "-e", "const assert=require('node:assert/strict'); const data={name:'Codex'}; assert.equal(data.name,'Codex')"],
  ["node", "-e", "(async()=>{ const m=await import('node:assert/strict'); m.default.equal('Codex','Codex') })()"],
  ["node", "-e", "const data={bin:'C:\\\\Pinned\\\\codex.exe'}; console.log(JSON.stringify(data))"],
  ["node", "-e", "require('child_process').spawnSync('git',['grep','Codex']); console.log('Codex')"],
  ["node", "-e", "const {spawnSync: run}=require('child_process'); run('node',['--version']); console.log('Codex')"],
  ["node", "-e", "const label='Codex'; const summarize=(x)=>JSON.stringify(x); console.log(summarize({label}))"],
  ["node", "-e", "const dependencies={'@openai/codex':'0.153.4'}; const count=function(x){return Object.keys(x).length}; console.log(count(dependencies))"],
  ["node", "-e", "const label='Codex'; const inspect=(x)=>{const count=(y)=>y.length; return count(x)}; console.log(inspect(label))"],
];

for (const command of allowed) {
  assert.equal(nestedCodexInvocationReason(command, { codexBin: configuredWindowsCodex }), null, JSON.stringify(command));
  assert.doesNotThrow(() => assertNoNestedCodexInvocation(command, { codexBin: configuredWindowsCodex }), JSON.stringify(command));
}

console.log("public command nested-Codex guard PASS");


const sshBlocked = [
  [
    [
      "ssh.exe",
      "-i", "C:\\keys\\id",
      "-o", "StrictHostKeyChecking=yes",
      "user@host",
      "sudo", "-n", "timeout", "10s",
      "pct", "exec", "183", "--keep-env", "0", "--",
      "/usr/bin/python3", "-c", "print('hello world')",
    ],
    "remote-arg-requires-shell-quoting",
  ],
  [["ssh", "user@host", "/usr/bin/printf", "hello world"], "remote-arg-requires-shell-quoting"],
  [["ssh", "user@host", "/usr/bin/bash", "-lc", "echo hello"], "remote-arg-requires-shell-quoting"],
  [["ssh", "user@host", "/usr/bin/printf", "{\"a\":1}"], "remote-arg-requires-shell-quoting"],
];

for (const [command, reason] of sshBlocked) {
  assert.equal(nestedSshRemoteArgvRisk(command)?.reason, reason, JSON.stringify(command));
}

const sshAllowed = [
  [
    "ssh.exe",
    "-i", "C:\\keys\\id",
    "-o", "UserKnownHostsFile=C:\\keys\\known_hosts",
    "-o", "StrictHostKeyChecking=yes",
    "user@host",
    "sudo", "-n", "timeout", "--signal=TERM", "--kill-after=2s", "10s",
    "pct", "exec", "183", "--keep-env", "0", "--",
    "/usr/bin/grep", "-n", "^HINDSIGHT_API_LLM_TIMEOUT=", "/etc/kira/kira-hindsight.env",
  ],
  ["ssh", "user@host", "/usr/bin/systemctl", "is-active", "kira-hindsight.service"],
  ["ssh", "-V"],
  ["git", "status", "--short"],
];

for (const command of sshAllowed) {
  assert.equal(nestedSshRemoteArgvRisk(command), null, JSON.stringify(command));
}

console.log("public command nested SSH argv guard PASS");

// Exercise the real public/household MCP guard, not only the shared helper.
const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const { Client } = require("@modelcontextprotocol/client");
const { InMemoryTransport } = require("@modelcontextprotocol/server");
const { createCodexToolboxServerFactory } = await import("../src/mcp-server-factory.mjs");

for (const publicPreview of [true, false]) {
  let dispatches = 0;
  const server = createCodexToolboxServerFactory({
    executor: { async exec() { dispatches += 1; return { exitCode: 0, stdout: "model-free fixture", stderr: "" }; } },
    publicPreview,
    guardDirectFormalCodex: true,
    toolAllowlist: ["codex.command_exec"],
    accessModes: ["readOnly", "inherit"],
    defaultAccess: "readOnly",
  })();
  const client = new Client({ name: "command-policy-regression", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    for (const [command] of blocked) {
      if (!publicPreview && command[0] === "codex" && command[1] === "--version") continue;
      const prior = dispatches;
      const result = await client.callTool({ name: "codex.command_exec", arguments: { command } });
      assert.equal(result.isError, true, JSON.stringify(command));
      assert.equal(result.structuredContent.errorCode, "FORMAL_CODEX_AGENT_REQUIRED");
      assert.equal(dispatches, prior, "blocked code must never reach the executor");
    }
    for (const command of [...allowed, ["powershell.exe", "-Command", "Write-Output 'direct Codex is ordinary text here'"]]) {
      const prior = dispatches;
      const result = await client.callTool({ name: "codex.command_exec", arguments: { command } });
      assert.equal(result.isError, false, JSON.stringify(command));
      assert.equal(dispatches, prior + 1, "allowed data reaches the original executor once");
    }
  } finally {
    await client.close();
    await server.close();
  }
}
console.log("public/household MCP command guard integration PASS");
