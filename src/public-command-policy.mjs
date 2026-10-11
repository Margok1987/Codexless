import { parse } from "acorn";

const CODEX_EXECUTABLE_RE = /^codex(?:\.(?:exe|com|cmd|bat|ps1))?$/i;
const CODEX_COMMAND_TOKEN_RE = /(?:^|[\s"'`;&|(),])(?:[^\s"'`;&|(),]*[\\/])?codex(?:\.(?:exe|com|cmd|bat|ps1))?(?=$|[\s"'`;&|(),])/i;
const SHELL_CODEX_COMMAND_HEAD_RE = /(?:^|(?:&&|\|\||[;|])\s*|(?:^|\s)&\s*)["']?(?:[^\s"'`;&|(),]*[\\/])?codex(?:\.(?:exe|com|cmd|bat|ps1))?["']?(?=$|[\s"'`;&|(),])/i;

const COMMAND_STRING_WRAPPERS = new Set([
  "cmd",
  "powershell",
  "pwsh",
  "sh",
  "bash",
  "zsh",
  "fish",
]);

const INLINE_CODE_WRAPPERS = new Set([
  "node",
  "nodejs",
  "python",
  "python3",
  "py",
  "ruby",
  "perl",
  "deno",
  "bun",
]);

const EXECUTABLE_LAUNCH_WRAPPERS = new Set([
  "env",
  "sudo",
  "wsl",
  "nohup",
  "timeout",
  "nice",
  "stdbuf",
  "xargs",
  "npx",
  "npm",
  "pnpm",
  "yarn",
]);

function portableBasename(value) {
  const normalized = String(value ?? "").replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  return (index >= 0 ? normalized.slice(index + 1) : normalized).toLowerCase();
}

function executableStem(value) {
  return portableBasename(value).replace(/\.(?:exe|com|cmd|bat|ps1)$/i, "");
}

function normalizedPortablePath(value) {
  return String(value ?? "").trim().replaceAll("\\", "/").toLowerCase();
}

function isCodexExecutableToken(value, codexBin = null) {
  const raw = String(value ?? "").trim().replace(/^['"]|['"]$/g, "");
  if (!raw) return false;
  if (CODEX_EXECUTABLE_RE.test(portableBasename(raw))) return true;
  return Boolean(codexBin && normalizedPortablePath(raw) === normalizedPortablePath(codexBin));
}

function containsCodexCommandToken(value, codexBin = null) {
  const text = String(value ?? "");
  if (CODEX_COMMAND_TOKEN_RE.test(text)) return true;
  if (!codexBin) return false;
  return normalizedPortablePath(text).includes(normalizedPortablePath(codexBin));
}

function javascriptCarriesNestedCodex(source, codexBin) {
  const comments = [];
  let ast;
  try {
    ast = parse(source, { ecmaVersion: "latest", sourceType: "module", allowAwaitOutsideFunction: true, onComment: comments });
  } catch {
    // Unsupported/invalid syntax never earns a data-only exemption.
    return containsCodexCommandToken(source, codexBin);
  }
  const nodes = [];
  const parents = new Map();
  const bindings = new Map();
  const ignored = comments.map(({ start, end }) => [start, end]);
  let hasCodexData = false;
  function walk(node, parent = null) {
    if (!node || typeof node !== "object") return;
    if (typeof node.type === "string") { nodes.push(node); parents.set(node, parent); }
    if (node.type === "Literal" && typeof node.value === "string") {
      ignored.push([node.start, node.end]);
      hasCodexData ||= containsCodexCommandToken(node.value, codexBin);
    }
    if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
      ignored.push([node.start, node.end]);
      hasCodexData ||= containsCodexCommandToken(node.quasis[0].value.cooked, codexBin);
    }
    if (node.type === "VariableDeclaration") for (const declaration of node.declarations) {
      if (declaration.id.type === "Identifier") {
        const name = declaration.id.name;
        bindings.set(name, bindings.has(name) || node.kind !== "const" ? null : declaration.init);
      } else if (declaration.id.type === "ObjectPattern") for (const property of declaration.id.properties) {
        if (property.type === "Property" && property.value.type === "Identifier") {
          const name = property.value.name;
          bindings.set(name, bindings.has(name) || node.kind !== "const" ? null : { type: "MemberExpression", computed: property.computed, object: declaration.init, property: property.key });
        }
      }
    }
    if (node.type === "ImportDeclaration") for (const specifier of node.specifiers) {
      if (specifier.type === "ImportSpecifier") bindings.set(specifier.local.name, { type: "ImportedBinding", name: specifier.imported.name });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach((child) => walk(child, node));
      else if (value && typeof value === "object" && typeof value.type === "string") walk(value, node);
    }
  }
  walk(ast);
  let executableText = source;
  for (const [start, end] of ignored.sort((a, b) => b[0] - a[0])) executableText = executableText.slice(0, start) + " ".repeat(end - start) + executableText.slice(end);
  if (containsCodexCommandToken(executableText, codexBin)) return true;

  function constant(node, seen = new Set()) {
    if (!node) return undefined;
    if (node.type === "Literal") return node.value;
    if (node.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked;
    if (node.type === "Identifier" && !seen.has(node.name)) return constant(bindings.get(node.name), new Set([...seen, node.name]));
    if (node.type === "ArrayExpression") {
      const values = node.elements.map((item) => constant(item, seen));
      return values.every((value) => value !== undefined) ? values : undefined;
    }
    if (node.type === "BinaryExpression" && node.operator === "+") {
      const left = constant(node.left, seen), right = constant(node.right, seen);
      return typeof left === "string" && typeof right === "string" ? left + right : undefined;
    }
    return undefined;
  }
  function invocationName(node, seen = new Set()) {
    if (node?.type === "ImportedBinding") return node.name;
    if (node?.type === "Identifier") {
      if (seen.has(node.name)) return null;
      return bindings.has(node.name) ? invocationName(bindings.get(node.name), new Set([...seen, node.name])) : node.name;
    }
    if (node?.type === "MemberExpression") return node.computed ? constant(node.property) : node.property.name;
    return null;
  }
  for (const node of nodes) {
    const parent = parents.get(node);
    const capability = invocationName(node);
    if (hasCodexData && ["Identifier", "MemberExpression"].includes(node.type)
      && ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork", "Command", "eval", "Function", "Worker", "runInContext", "runInNewContext", "runInThisContext", "compileFunction"].includes(capability)
      && ((["CallExpression", "NewExpression"].includes(parent?.type) && parent.callee !== node)
        || (parent?.type === "MemberExpression" && parent.object === node)
        || ["ArrayExpression", "ReturnStatement", "AssignmentExpression", "SequenceExpression"].includes(parent?.type))) return true;
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"].includes(node.type)) {
      const specifier = constant(node.source);
      if (node.source && (typeof specifier === "string" ? containsCodexCommandToken(specifier, codexBin) : hasCodexData)) return true;
    }
    if (hasCodexData && node.type === "MemberExpression" && ["constructor", "mainModule", "binding", "_linkedBinding", "dlopen", "getBuiltinModule"].includes(invocationName(node))) return true;
    if (!["CallExpression", "NewExpression"].includes(node.type)) continue;
    const name = invocationName(node.callee);
    if (hasCodexData && node.callee.type === "Identifier" && bindings.has(node.callee.name) && name === null) {
      const definition = bindings.get(node.callee.name);
      // Local function bodies are walked above; calling them is not an opaque capability alias.
      if (!["ArrowFunctionExpression", "FunctionExpression"].includes(definition?.type)) return true;
    }
    if (hasCodexData && node.callee.type === "MemberExpression" && typeof name !== "string") return true;
    if (hasCodexData && ["eval", "Function", "Worker", "runInContext", "runInNewContext", "runInThisContext", "compileFunction"].includes(name)) return true;
    if (name === "require") {
      const specifier = constant(node.arguments[0]);
      if (typeof specifier === "string" ? containsCodexCommandToken(specifier, codexBin) : hasCodexData) return true;
    }
    if (["spawn", "spawnSync", "execFile", "execFileSync", "fork", "Command"].includes(name)) {
      const executable = constant(node.arguments[0]);
      const argv = node.arguments.length > 1 ? constant(node.arguments[1]) : [];
      // Unknown argv/options are not proof that the subprocess is model-free.
      if (typeof executable === "string" && isCodexExecutableToken(executable, codexBin)) return true;
      if (typeof executable === "string" && Array.isArray(argv) && nestedCodexInvocationReason([executable, ...argv], { codexBin })) return true;
      if (hasCodexData && (typeof executable !== "string" || !Array.isArray(argv))) return true;
    }
    if (["exec", "execSync"].includes(name)) {
      const commandText = constant(node.arguments[0]);
      if (typeof commandText === "string" ? containsCodexCommandToken(commandText, codexBin) : hasCodexData) return true;
    }
  }
  return false;
}

function shellWrapperCommandText(args, wrapper) {
  const flags = wrapper === "cmd" ? ["/c", "/k"] : ["powershell", "pwsh"].includes(wrapper) ? ["-command", "-c"] : ["-c", "-lc"];
  const index = args.findIndex((arg) => flags.includes(String(arg).toLowerCase()));
  if (index < 0) return null;
  return wrapper === "cmd" || ["powershell", "pwsh"].includes(wrapper) ? args.slice(index + 1).join(" ").trim() : String(args[index + 1] ?? "").trim();
}

function wrapperCarriesNestedCodex(command, wrapper, codexBin, shellCommandHeadsOnly) {
  const args = command.slice(1);
  if (COMMAND_STRING_WRAPPERS.has(wrapper)) {
    if (shellCommandHeadsOnly) {
      const text = shellWrapperCommandText(args, wrapper);
      return text ? SHELL_CODEX_COMMAND_HEAD_RE.test(text) : false;
    }
    return args.some((arg) => containsCodexCommandToken(arg, codexBin));
  }

  if (INLINE_CODE_WRAPPERS.has(wrapper)) {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      const prior = args[index - 1];
      const inlineCode = ["-e", "--eval", "-c", "-Command", "--command", "-p", "--print"].includes(prior)
        || /^-(?:e|c|p)=/.test(arg)
        || /^--(?:eval|command|print)=/.test(arg)
        || (wrapper === "deno" && prior === "eval");
      if (!inlineCode) continue;
      const source = /^(?:-(?:e|c|p)|--(?:eval|command|print))=/.test(arg) ? arg.slice(arg.indexOf("=") + 1) : arg;
      if (["node", "nodejs", "bun"].includes(wrapper) ? javascriptCarriesNestedCodex(source, codexBin) : containsCodexCommandToken(source, codexBin)) return true;
    }
    return false;
  }

  if (EXECUTABLE_LAUNCH_WRAPPERS.has(wrapper)) {
    return args.some((arg) => isCodexExecutableToken(arg, codexBin) || containsCodexCommandToken(arg, codexBin));
  }

  return false;
}


const SSH_EXECUTABLE_STEMS = new Set(["ssh"]);
const SSH_OPTIONS_WITH_VALUE = new Set([
  "-b", "-B", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l",
  "-m", "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w",
]);
const SSH_OPTIONS_WITHOUT_VALUE = new Set([
  "-4", "-6", "-A", "-a", "-C", "-f", "-G", "-g", "-K", "-k", "-M", "-N",
  "-n", "-q", "-s", "-T", "-t", "-V", "-v", "-X", "-x", "-Y", "-y",
]);
const SIMPLE_REMOTE_ARG_RE = /^[A-Za-z0-9_./:@%+=,^,-]+$/;

function sshRemoteCommandArgs(command) {
  if (!Array.isArray(command) || command.length < 2) return null;
  const executable = executableStem(command[0]);
  if (!SSH_EXECUTABLE_STEMS.has(executable)) return null;

  const args = command.slice(1).map((value) => String(value));
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === "--") {
      index += 1;
      break;
    }
    if (!arg.startsWith("-") || arg === "-") break;

    if (SSH_OPTIONS_WITH_VALUE.has(arg)) {
      if (index + 1 >= args.length) return null;
      index += 2;
      continue;
    }
    if (SSH_OPTIONS_WITHOUT_VALUE.has(arg)) {
      index += 1;
      continue;
    }

    const optionName = arg.slice(0, 2);
    if (SSH_OPTIONS_WITH_VALUE.has(optionName) && arg.length > 2) {
      index += 1;
      continue;
    }

    return null;
  }

  if (index >= args.length) return null;
  const destination = args[index];
  if (!destination || destination.startsWith("-")) return null;
  return args.slice(index + 1);
}

export function nestedSshRemoteArgvRisk(command) {
  const remoteArgs = sshRemoteCommandArgs(command);
  if (!remoteArgs || remoteArgs.length === 0) return null;

  for (let index = 0; index < remoteArgs.length; index += 1) {
    const arg = remoteArgs[index];
    if (!arg || !SIMPLE_REMOTE_ARG_RE.test(arg)) {
      return {
        reason: "remote-arg-requires-shell-quoting",
        remoteArgIndex: index,
      };
    }
  }
  return null;
}

export function nestedCodexInvocationReason(command, { codexBin = null, shellCommandHeadsOnly = false } = {}) {
  if (!Array.isArray(command) || command.length === 0) return null;
  if (isCodexExecutableToken(command[0], codexBin)) return "direct-codex-executable";
  const wrapper = executableStem(command[0]);
  if (wrapperCarriesNestedCodex(command, wrapper, codexBin, shellCommandHeadsOnly)) return `codex-via-${wrapper}`;
  return null;
}

export function assertNoNestedCodexInvocation(command, { codexBin = null } = {}) {
  const reason = nestedCodexInvocationReason(command, { codexBin });
  if (!reason) return;
  const error = new Error(
    "Codexless command_exec refuses to launch Codex CLI from the model-free command lane. " +
    "Use codex.agent_start / codex.agent_send so metered Codex work keeps its Task Card, quota state, and explicit lifecycle."
  );
  error.code = "METERED_CODEX_REQUIRES_AGENT_CARD";
  error.nextActions = [
    "Use codex.agent_start for a new formal Codex task.",
    "Use codex.agent_send only for an existing Codexless agentRef follow-up.",
    "Keep codex.command_exec for model-free local commands; do not use shell/interpreter wrappers to launch Codex.",
  ];
  error.reason = reason;
  throw error;
}
