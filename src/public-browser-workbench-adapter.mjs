const CHROME_SKILL_NAME = "chrome:control-chrome";
const NODE_REPL_SERVER = "node_repl";
const NODE_REPL_TOOL = "js";

export class CodexPublicBrowserWorkbenchAdapter {
  #context;

  constructor({ context }) {
    if (!context) throw new Error("CodexPublicBrowserWorkbenchAdapter requires public context");
    this.#context = context;
  }

  get generation() {
    return Number.isInteger(this.#context.generation) ? this.#context.generation : 0;
  }

  async catalog({ kind, cwd }) {
    const prerequisite = await this.#context.browserPrerequisites({ cwd });
    if (kind === "skills") {
      return {
        skills: prerequisite.chromeSkillPath
          ? [{ name: CHROME_SKILL_NAME, path: prerequisite.chromeSkillPath, enabled: true }]
          : [],
      };
    }
    if (kind === "mcp") {
      return {
        servers: [{
          name: NODE_REPL_SERVER,
          tools: prerequisite.nodeRepl ? [{ name: NODE_REPL_TOOL }] : [],
          error: prerequisite.nodeReplError ?? (prerequisite.status === "ok" ? null : prerequisite.reason ?? null),
        }],
      };
    }
    throw new Error(`unsupported Browser adapter catalog kind: ${String(kind)}`);
  }

  async mcpCall({ server, tool, cwd, arguments: args = {}, meta = null, expectedGeneration = null }) {
    if (server !== NODE_REPL_SERVER || tool !== NODE_REPL_TOOL) {
      throw new Error("Codexless Browser adapter only exposes node_repl/js to the accepted Browser implementation");
    }
    try {
      return await this.#context.nodeReplCall({ cwd, arguments: args, meta, expectedGeneration });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/PUBLIC_CONTEXT_GENERATION_STALE/i.test(message)) {
        throw new Error(`WORKBENCH_GENERATION_STALE:${message}`);
      }
      throw error;
    }
  }
}
