import { spawn } from "node:child_process";

export class CodexRpcError extends Error {
  constructor(method, rpcError) {
    super(`${method} failed: ${rpcError?.message || JSON.stringify(rpcError)}`);
    this.name = "CodexRpcError";
    this.method = method;
    this.rpcError = rpcError;
  }
}

export class CodexRpcTimeoutError extends Error {
  constructor(method, timeoutMs) {
    super(`${method} timed out after ${timeoutMs}ms`);
    this.name = "CodexRpcTimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

export class CodexAppServerClient {
  #cwd;
  #launchFactory;
  #child = null;
  #cleanup = null;
  #buffer = "";
  #nextId = 1;
  #pending = new Map();
  #notificationMethods = new Set();
  #notificationHandlers = new Set();
  #serverRequestMethods = new Set();
  #serverRequestHandler = null;
  #pendingServerRequests = new Map();
  #initializedResult = null;
  #defaultRequestTimeoutMs;
  #maxStdoutBufferBytes;
  #initializeCapabilities;
  #closing = false;
  #generation = 0;
  #startPromise = null;
  #launchPromise = null;
  #closePromise = null;
  #closeError = null;
  #stderrHandler;

  constructor({
    bin,
    cwd,
    clientInfo = {},
    launch,
    requestTimeoutMs = 30_000,
    maxStdoutBufferBytes = 1_048_576,
    initializeCapabilities = null,
    serverRequestHandler = null,
    stderrHandler = null,
  }) {
    if (!launch && !bin) {
      throw new Error("CodexAppServerClient requires either a codex binary path or a launch factory");
    }
    if (launch && typeof launch !== "function") {
      throw new Error("CodexAppServerClient launch must be a function returning a spawn spec");
    }

    if (!Number.isInteger(maxStdoutBufferBytes) || maxStdoutBufferBytes < 1 || maxStdoutBufferBytes > 16 * 1024 * 1024) {
      throw new Error("maxStdoutBufferBytes must be an integer from 1 to 16777216");
    }
    if (serverRequestHandler !== null && typeof serverRequestHandler !== "function") {
      throw new Error("serverRequestHandler must be a function when provided");
    }
    if (stderrHandler !== null && typeof stderrHandler !== "function") {
      throw new Error("stderrHandler must be a function when provided");
    }

    this.#cwd = cwd;
    this.#defaultRequestTimeoutMs = requestTimeoutMs;
    this.#maxStdoutBufferBytes = maxStdoutBufferBytes;
    this.#initializeCapabilities = initializeCapabilities;
    this.#serverRequestHandler = serverRequestHandler;
    this.#stderrHandler = stderrHandler ?? ((chunk) => process.stderr.write(`[codex-app-server] ${chunk}`));
    this.#launchFactory = launch ?? (() => ({
      command: bin,
      args: ["app-server", "--stdio"],
      options: { cwd: this.#cwd },
    }));
    this.clientInfo = {
      name: clientInfo.name ?? "codex_toolbox_bridge",
      title: clientInfo.title ?? "Codexless",
      version: clientInfo.version ?? "0.0.1",
    };
  }

  get notificationMethods() {
    return [...this.#notificationMethods];
  }

  get serverRequestMethods() {
    return [...this.#serverRequestMethods];
  }

  get pendingServerRequestIds() {
    return [...this.#pendingServerRequests.values()].map((entry) => entry.id);
  }

  get initializedResult() {
    return this.#initializedResult;
  }

  onNotification(handler) {
    if (typeof handler !== "function") throw new Error("notification handler must be a function");
    this.#notificationHandlers.add(handler);
    return () => this.#notificationHandlers.delete(handler);
  }

  get running() {
    return Boolean(this.#child);
  }

  async start() {
    if (this.#closing || this.#closeError) throw new Error("Codex App Server client is closing or its cleanup failed");
    if (this.#startPromise) return this.#startPromise;
    if (this.#child) return this.#initializedResult;
    const generation = this.#generation;
    // Reserve before invoking an asynchronous or re-entrant launch factory.
    const starting = Promise.resolve().then(() => this.#startInternal(generation));
    this.#startPromise = starting;
    try { return await starting; }
    finally { if (this.#startPromise === starting) this.#startPromise = null; }
  }

  async #startInternal(generation) {
    if (this.#closing || generation !== this.#generation) throw new Error("Codex App Server start was cancelled by close");
    this.#buffer = "";
    this.#initializedResult = null;
    const launching = Promise.resolve().then(async () => {
      const spec = await this.#launchFactory();
      if (!spec?.command) throw new Error("Codex App Server launch factory returned no command");
      if (this.#closing || generation !== this.#generation) {
        if (typeof spec.cleanup === "function") {
          try { await spec.cleanup(); }
          catch (error) { this.#closeError = error; throw error; }
        }
        throw new Error("Codex App Server start was cancelled by close");
      }
      const child = spawn(spec.command, spec.args ?? [], {
        cwd: spec.options?.cwd ?? this.#cwd,
        env: spec.options?.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: spec.options?.windowsHide ?? true,
        shell: false,
      });
      this.#child = child;
      this.#cleanup = typeof spec.cleanup === "function" ? spec.cleanup : null;
      child.stdin.on("error", (error) => { if (this.#child === child) this.#failAll(error); });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { if (this.#child === child) this.#onStdout(chunk); });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        try { this.#stderrHandler(chunk); }
        catch { process.stderr.write("[codex-app-server] stderr handler failed\n"); }
      });
      child.on("error", (error) => { if (this.#child === child) this.#failAll(error); });
      child.on("exit", (code, signal) => {
        const wasRunning = this.#child === child;
        if (wasRunning && !this.#closing) {
          this.#child = null;
          const exitError = new Error(`codex app-server exited: code=${code} signal=${signal}`);
          if (this.#pending.size) this.#failAll(exitError);
          if (this.#pendingServerRequests.size) this.#abandonServerRequests(exitError);
        }
      });
      return child;
    });
    this.#launchPromise = launching;
    try {
      await launching;
      if (this.#closing || generation !== this.#generation) throw new Error("Codex App Server start was cancelled by close");
      const initializeParams = { clientInfo: this.clientInfo };
      if (this.#initializeCapabilities) initializeParams.capabilities = this.#initializeCapabilities;
      this.#initializedResult = await this.request("initialize", initializeParams,
        { timeoutMs: Math.min(this.#defaultRequestTimeoutMs, 15_000) });
      if (this.#closing || generation !== this.#generation) throw new Error("Codex App Server start was cancelled by close");
      this.notify("initialized", {});
      return this.#initializedResult;
    } catch (error) {
      // An external close is already draining this launch. Do not await it
      // recursively from the initialization it is trying to cancel.
      if (!this.#closing && generation === this.#generation) await this.close();
      throw error;
    } finally { if (this.#launchPromise === launching) this.#launchPromise = null; }
  }

  request(method, params, { timeoutMs = this.#defaultRequestTimeoutMs } = {}) {
    if (!this.#child || this.#closing || this.#closeError) throw new Error("codex app-server is not available for requests");
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const key = String(id);
      const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            const waiter = this.#pending.get(key);
            if (!waiter) return;
            this.#pending.delete(key);
            const timeoutError = new CodexRpcTimeoutError(method, timeoutMs);
            void (async () => {
              try {
                await this.close();
                waiter.reject(timeoutError);
              } catch (cleanupError) {
                waiter.reject(new AggregateError(
                  [timeoutError, cleanupError],
                  `${timeoutError.message}; cleanup also failed`
                ));
              }
            })();
          }, timeoutMs)
        : null;
      timer?.unref?.();

      this.#pending.set(key, { method, resolve, reject, timer });
      try { this.#send({ id, method, params }); }
      catch (error) {
        if (timer) clearTimeout(timer);
        this.#pending.delete(key);
        reject(error);
      }
    });
  }

  notify(method, params) {
    if (!this.#child || this.#closing || this.#closeError) throw new Error("codex app-server is not available for notifications");
    this.#send({ method, params });
  }

  exec(params, options) {
    return this.request("command/exec", params, options);
  }

  async close() {
    if (this.#closePromise) return this.#closePromise;
    if (this.#closeError) throw this.#closeError;
    this.#closing = true;
    this.#generation += 1;
    const launch = this.#launchPromise;
    const closing = Promise.resolve().then(async () => {
      // Await only resource creation, not full initialization (whose pending
      // RPC needs this close to finish). Late launch cleanup runs in that scope.
      if (launch) await Promise.allSettled([launch]);
      if (this.#closeError) throw this.#closeError;
      const child = this.#child;
      if (child && this.#pendingServerRequests.size) this.#closePendingServerRequests();
      this.#failAll(new Error("codex app-server closed before pending requests completed"));
      if (child) {
        try { child.stdin.end(); } catch {}
        if (!await this.#waitForExit(child, 1_000)) {
          try { child.kill(); } catch {}
          if (!await this.#waitForExit(child, 2_000)) {
            try { child.kill("SIGKILL"); } catch {}
            if (!await this.#waitForExit(child, 2_000)) {
              throw Object.assign(new Error("Codex App Server process exit could not be verified; state cleanup was not run"), { code: "CODEX_PROCESS_EXIT_UNVERIFIED" });
            }
          }
        }
      }
      // Release state only after the owned process is actually gone.
      if (this.#child === child) this.#child = null;
      const cleanup = this.#cleanup;
      this.#cleanup = null;
      if (cleanup) await cleanup();
      this.#initializedResult = null;
      this.#buffer = "";
    });
    this.#closePromise = closing;
    try { return await closing; }
    catch (error) { this.#closeError = error; throw error; }
    finally {
      this.#closing = false;
      if (!this.#closeError && this.#closePromise === closing) this.#closePromise = null;
    }
  }

  #waitForExit(child, timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer;
      const finish = (exited) => {
        if (timer) clearTimeout(timer);
        child.off("exit", onExit);
        child.off("close", onExit);
        resolve(exited);
      };
      const onExit = () => finish(true);
      child.once("exit", onExit);
      child.once("close", onExit);
      timer = setTimeout(() => finish(false), timeoutMs);
    });
  }

  #send(message) {
    if (!this.#child) throw new Error("codex app-server is not started");
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onStdout(chunk) {
    this.#buffer += chunk;
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) {
        if (Buffer.byteLength(this.#buffer, "utf8") > this.#maxStdoutBufferBytes) {
          this.#protocolFailure(new Error("Codex App Server response frame exceeded the configured buffer limit; protocol contents are withheld"));
        }
        return;
      }
      const rawLine = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (Buffer.byteLength(rawLine, "utf8") > this.#maxStdoutBufferBytes) {
        this.#protocolFailure(new Error("Codex App Server response frame exceeded the configured buffer limit; protocol contents are withheld"));
        return;
      }
      const line = rawLine.trim();
      if (!line) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.#protocolFailure(new Error("Invalid Codex App Server JSON response; protocol contents are withheld"));
        return;
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        this.#protocolFailure(new Error("Invalid Codex App Server response envelope; protocol contents are withheld"));
        return;
      }

      const key = message.id === undefined ? null : String(message.id);
      if (key !== null && this.#pending.has(key)) {
        const waiter = this.#pending.get(key);
        this.#pending.delete(key);
        if (waiter.timer) clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new CodexRpcError(waiter.method, message.error));
        else waiter.resolve(message.result);
        continue;
      }

      if (key !== null && typeof message.method === "string") {
        this.#serverRequestMethods.add(message.method);
        if (!this.#serverRequestHandler) {
          this.#send({
            id: message.id,
            error: {
              code: -32601,
              message: `Server-initiated request not supported by Codexless: ${message.method}`,
            },
          });
          continue;
        }

        if (this.#pendingServerRequests.has(key)) {
          this.#send({
            id: message.id,
            error: { code: -32600, message: `Duplicate server request id: ${String(message.id)}` },
          });
          continue;
        }

        const handle = this.#createServerRequestHandle(message);
        try {
          const handlerResult = this.#serverRequestHandler(handle);
          Promise.resolve(handlerResult).catch((error) => {
            if (!handle.settled) {
              try {
                handle.reject({
                  code: -32603,
                  message: `serverRequestHandler failed: ${error instanceof Error ? error.message : String(error)}`,
                });
              } catch {}
            }
          });
        } catch (error) {
          if (!handle.settled) {
            handle.reject({
              code: -32603,
              message: `serverRequestHandler failed: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }
        continue;
      }

      if (typeof message.method === "string") {
        this.#notificationMethods.add(message.method);
        if (message.method === "serverRequest/resolved") {
          this.#settleServerRequestFromServer(message.params);
        }
        for (const handler of this.#notificationHandlers) {
          try {
            handler(message);
          } catch (error) {
            process.stderr.write(`[codex-app-server] notification handler failure: ${error instanceof Error ? error.message : String(error)}\n`);
          }
        }
      }
    }
  }

  #createServerRequestHandle(message) {
    const key = String(message.id);
    const entry = {
      id: message.id,
      method: message.method,
      params: message.params,
      settled: false,
      settlement: null,
      handle: null,
    };
    const handle = {
      id: entry.id,
      method: entry.method,
      params: entry.params,
      get settled() {
        return entry.settled;
      },
      get settlement() {
        return entry.settlement;
      },
      resolve: (result) => this.#settleServerRequest(key, { kind: "resolve", result }),
      reject: (error) => this.#settleServerRequest(key, { kind: "reject", error }),
    };
    entry.handle = Object.freeze(handle);
    this.#pendingServerRequests.set(key, entry);
    return entry.handle;
  }

  #settleServerRequest(key, settlement) {
    const entry = this.#pendingServerRequests.get(key);
    if (!entry) throw new Error(`server request is unknown or already settled: ${key}`);
    if (!this.#child) throw new Error(`cannot settle server request after Codex App Server closed: ${key}`);

    if (settlement.kind === "resolve") {
      this.#send({ id: entry.id, result: settlement.result });
    } else {
      const error = settlement.error && typeof settlement.error === "object"
        ? settlement.error
        : { code: -32000, message: String(settlement.error ?? "server request rejected") };
      this.#send({ id: entry.id, error });
    }
    entry.settled = true;
    entry.settlement = settlement;
    this.#pendingServerRequests.delete(key);
    return true;
  }

  #settleServerRequestFromServer(params) {
    const requestId = params?.requestId;
    if (requestId === undefined || requestId === null) return false;
    const key = String(requestId);
    const entry = this.#pendingServerRequests.get(key);
    if (!entry) return false;
    entry.settled = true;
    entry.settlement = { kind: "serverResolved", params };
    this.#pendingServerRequests.delete(key);
    return true;
  }

  #closePendingServerRequests() {
    for (const [key, entry] of this.#pendingServerRequests) {
      const error = {
        code: -32000,
        message: `Codex Toolbox client closed before server request was resolved: ${entry.method}`,
      };
      try {
        this.#send({ id: entry.id, error });
      } catch {}
      entry.settled = true;
      entry.settlement = { kind: "reject", error };
      this.#pendingServerRequests.delete(key);
    }
  }

  #abandonServerRequests(error) {
    for (const [key, entry] of this.#pendingServerRequests) {
      const rpcError = {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      };
      entry.settled = true;
      entry.settlement = { kind: "reject", error: rpcError };
      this.#pendingServerRequests.delete(key);
    }
  }

  #protocolFailure(error) {
    this.#failAll(error);
    this.#abandonServerRequests(error);
    // During initialization, #startInternal owns the close and awaits it before
    // rejecting start(). After initialization, no start waiter exists, so the
    // protocol failure must close the owned process itself.
    if (!this.#startPromise) void this.close().catch(() => {});
  }

  #failAll(error) {
    for (const waiter of this.#pending.values()) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#pending.clear();
  }
}
