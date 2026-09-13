import { AsyncLocalStorage } from "node:async_hooks";

const ACCOUNT_SCOPED_TOOLS = new Set(["codex.agent_start", "codex.agent_commit"]);

export function createFormalAgentAccountContext({ agentPreviewState, agentExecutor } = {}) {
  if (!agentPreviewState?.taskRecords || !(agentPreviewState.taskRecords instanceof Map)) {
    throw new TypeError("formal agent account context requires the shared agent task state");
  }
  if (!agentExecutor || typeof agentExecutor.resolveAccountId !== "function") {
    throw new TypeError("formal agent account context requires an account-aware agent executor");
  }

  const storage = new AsyncLocalStorage();

  function accountForPreparedTask(taskId) {
    if (typeof taskId !== "string" || !taskId) return null;
    const matches = [...agentPreviewState.taskRecords.values()].filter((record) =>
      record?.taskId === taskId || record?.shortTaskId === taskId || record?.taskRef === taskId);
    if (matches.length !== 1) return null;
    const record = matches[0];
    return typeof record?.payload?.account === "string" && record.payload.account
      ? record.payload.account
      : typeof record?.taskCard?.account === "string" && record.taskCard.account
        ? record.taskCard.account
        : null;
  }

  function accountForTool(name, input) {
    if (name === "codex.agent_start") return agentExecutor.resolveAccountId(input?.account ?? null);
    if (name === "codex.agent_commit") return accountForPreparedTask(input?.taskId);
    return null;
  }

  return Object.freeze({
    currentAccount() {
      const account = storage.getStore()?.account;
      return typeof account === "string" && account ? account : null;
    },
    wrapToolHandler(name, handler) {
      if (!ACCOUNT_SCOPED_TOOLS.has(name) || typeof handler !== "function") return handler;
      return async (input, ...rest) => {
        const account = accountForTool(name, input);
        // Unknown/stale task IDs must still be handled by the canonical task
        // state code so callers receive its exact fail-closed error contract.
        if (!account) return handler(input, ...rest);
        return storage.run(Object.freeze({ account }), () => handler(input, ...rest));
      };
    },
  });
}
