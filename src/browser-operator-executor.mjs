import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { BrowserReaderError } from "./browser-reader-executor.mjs";
import { resolveAuthorizedExistingFile } from "./construction-tools.mjs";

const ACTION_TTL_MS = 5 * 60_000;
const POST_SNAPSHOT_CHARS = 20_000;
const MAX_SCREENSHOT_BYTES = 5_000_000;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const FIXED_KEYS = new Set(["Enter", "Tab", "Escape"]);
const FILL_ROLES = new Set(["textbox", "searchbox"]);

export class CodexBrowserOperatorExecutor {
  #reader;
  #authorityExecutor;
  #defaultCwd;
  #actions = new Map();

  constructor({ reader, authorityExecutor, defaultCwd }) {
    if (!reader) throw new Error("CodexBrowserOperatorExecutor requires Browser Reader executor");
    if (!authorityExecutor) throw new Error("CodexBrowserOperatorExecutor requires authorityExecutor");
    if (!defaultCwd) throw new Error("CodexBrowserOperatorExecutor requires defaultCwd");
    this.#reader = reader;
    this.#authorityExecutor = authorityExecutor;
    this.#defaultCwd = path.resolve(defaultCwd);
  }

  async confirmationPolicy({ cwd = this.#defaultCwd } = {}) {
    const result = await this.#reader.runBrowserJson({
      cwd,
      title: "Read Codex Browser confirmation policy",
      body: `
const __cxPolicy = await globalThis.__codexlessBrowserAgent.documentation.get("confirmations");
if (typeof __cxPolicy !== "string" || !__cxPolicy.trim()) throw new Error("CODEXLESS_BROWSER_CONFIRMATION_POLICY_UNAVAILABLE");
nodeRepl.write(JSON.stringify({ policy: __cxPolicy }));`,
    });
    const codexPolicy = typeof result?.policy === "string" ? result.policy : "";
    if (!codexPolicy.trim()) {
      throw new BrowserReaderError(
        "BROWSER_CONFIRMATION_POLICY_UNAVAILABLE",
        "The current Codex Chrome Skill returned no Browser confirmation policy",
        ["Do not invent a replacement permission taxonomy. Restore/update the Codex Chrome Skill and retry."]
      );
    }
    return {
      status: "ok",
      source: "current Codex Chrome Skill / confirmations",
      codexPolicy,
      interactionGuidance: {
        defaultMode: "task_level_verbal_confirmation",
        rule: "Apply the current Codex Browser confirmation policy to the bounded user task. Ask once for the task when the policy requires confirmation; do not prompt again for routine actions inside the unchanged task. Reconfirm only for a materially expanded risk class or a higher-level action-time requirement.",
      },
      note: "This dynamically reads the installed Codex Browser confirmation policy. It does not grant permission, mutate browser state, or start a metered Codex turn.",
    };
  }

  async screenshot({ tabRef, cwd = this.#defaultCwd }) {
    const binding = await this.#reader.tabBinding({ tabRef, cwd });
    const result = await this.#reader.runBrowserJson({
      cwd: binding.cwd,
      expectedGeneration: binding.contextGeneration,
      title: "Capture current Chrome viewport",
      body: claimBody(binding, `
const __cxShot = await __cxTab.screenshot({ fullPage: false });
const __cxBytes = __cxShot instanceof Uint8Array ? __cxShot : new Uint8Array(__cxShot);
__cxPayload = {
  title: (await __cxTab.title()) ?? __cxInfo.title ?? null,
  url: (await __cxTab.url()) ?? __cxInfo.url ?? null,
  byteLength: __cxBytes.byteLength,
  dataBase64: Buffer.from(__cxBytes).toString("base64"),
};`),
    });
    const dataBase64 = typeof result?.dataBase64 === "string" ? result.dataBase64 : "";
    const bytes = dataBase64 ? Buffer.from(dataBase64, "base64") : Buffer.alloc(0);
    if (!bytes.length || bytes.length > MAX_SCREENSHOT_BYTES) {
      throw new BrowserReaderError(
        bytes.length ? "BROWSER_SCREENSHOT_TOO_LARGE" : "BROWSER_SCREENSHOT_PROTOCOL_ERROR",
        bytes.length ? `Viewport screenshot exceeded ${MAX_SCREENSHOT_BYTES} bytes` : "Chrome screenshot returned no image bytes"
      );
    }
    const mimeType = detectImageMime(bytes);
    if (!mimeType) throw new BrowserReaderError("BROWSER_SCREENSHOT_FORMAT_UNSUPPORTED", "Chrome screenshot was neither JPEG nor PNG");
    const tab = this.#reader.updateTabState(tabRef, { title: result?.title, url: result?.url });
    return { status: "ok", browser: "chrome", tab, mimeType, byteLength: bytes.length, fullPage: false, dataBase64 };
  }

  async prepareCloseTab({ tabRef, cwd = this.#defaultCwd }) {
    const binding = await this.#reader.tabBinding({ tabRef, cwd });
    const current = await this.#reader.runBrowserJson({
      cwd: binding.cwd,
      expectedGeneration: binding.contextGeneration,
      title: "Prepare exact Chrome tab close",
      body: `
const __cxBrowser = await globalThis.__codexlessBrowserAgent.browsers.get("chrome");
const __cxOpenTabs = await __cxBrowser.user.openTabs();
const __cxInfo = __cxOpenTabs.find((tab) => tab.providerTabId === ${JSON.stringify(binding.providerTabId)});
if (!__cxInfo) throw new Error("CODEXLESS_BROWSER_TAB_STALE");
nodeRepl.write(JSON.stringify({ title: __cxInfo.title ?? null, url: __cxInfo.url ?? null, lastOpened: __cxInfo.lastOpened ?? null }));`,
    });
    const currentUrl = typeof current?.url === "string" && current.url ? current.url : null;
    if (!currentUrl) {
      throw new BrowserReaderError(
        "BROWSER_CLOSE_URL_UNAVAILABLE",
        "The current Chrome tab did not expose a URL, so Codexless cannot safely bind this close action"
      );
    }
    const tab = this.#reader.updateTabState(tabRef, { title: current?.title, url: currentUrl, lastOpened: current?.lastOpened });
    return this.#storeAction({
      kind: "close_tab",
      tabRef,
      providerTabId: binding.providerTabId,
      expectedUrl: currentUrl,
      cwd: binding.cwd,
      generation: binding.contextGeneration,
    }, {
      action: { kind: "close_tab", tab, expectedUrl: currentUrl },
      nextAction: "Apply codex.browser_confirmation_policy plus current user-authored task context before closing this exact tab. A tab may contain unsaved input; the opaque ref binds the exact close but is not permission evidence.",
    });
  }

  async closeTab({ actionApprovalRef }) {
    const prepared = this.#consumeAction(actionApprovalRef, "close_tab");
    this.#assertGeneration(prepared);
    const binding = await this.#reader.tabBinding({ tabRef: prepared.tabRef, cwd: prepared.cwd });
    if (binding.providerTabId !== prepared.providerTabId) {
      throw new BrowserReaderError("BROWSER_ACTION_TAB_STALE", "The prepared close no longer matches the current Browser tab");
    }
    const result = await this.#reader.runBrowserJson({
      cwd: prepared.cwd,
      expectedGeneration: prepared.generation,
      mutationKind: "close_tab",
      title: "Execute prepared Chrome tab close",
      body: `
const __cxBrowser = await globalThis.__codexlessBrowserAgent.browsers.get("chrome");
const __cxOpenTabs = await __cxBrowser.user.openTabs();
const __cxInfo = __cxOpenTabs.find((tab) => tab.providerTabId === ${JSON.stringify(prepared.providerTabId)});
if (!__cxInfo) throw new Error("CODEXLESS_BROWSER_TAB_STALE");
let __cxTab = null;
let __cxPayload = null;
let __cxDispatchAttempted = false;
let __cxActionError = null;
let __cxReleaseError = null;
try {
  const __cxOwnedTabs = await __cxBrowser.tabs.list();
  const __cxOwnedInfo = __cxOwnedTabs.find((tab) => String(tab.id) === String(__cxInfo.providerTabId));
  __cxTab = __cxOwnedInfo ? await __cxBrowser.tabs.get(__cxOwnedInfo.id) : await __cxBrowser.user.claimTab(__cxInfo);
  const __cxBeforeUrl = (await __cxTab.url()) ?? __cxInfo.url ?? null;
  if (__cxBeforeUrl !== ${JSON.stringify(prepared.expectedUrl)}) throw new Error("CODEXLESS_BROWSER_ACTION_URL_CHANGED");
  __cxDispatchAttempted = true;
  await __cxTab.close();
  __cxPayload = { beforeUrl: __cxBeforeUrl, closed: true };
} catch (__cxError) {
  __cxActionError = __cxError;
} finally {
  if (__cxTab && !__cxDispatchAttempted && typeof __cxBrowser.tabs.finalize === "function") {
    try { await __cxBrowser.tabs.finalize({ keep: [] }); }
    catch (__cxError) { __cxReleaseError = __cxError; }
  }
}
if (__cxDispatchAttempted && __cxActionError) {
  const __cxMessage = __cxActionError instanceof Error ? __cxActionError.message : String(__cxActionError);
  if (/CODEXLESS_BROWSER_CLOSE_RESULT_UNCERTAIN/i.test(__cxMessage)) throw __cxActionError;
  throw new Error("CODEXLESS_BROWSER_CLOSE_RESULT_UNCERTAIN:" + __cxMessage);
}
if (__cxActionError) throw __cxActionError;
if (__cxReleaseError) throw __cxReleaseError;
nodeRepl.write(JSON.stringify(__cxPayload));`,
    });
    if (result?.closed !== true) {
      throw new BrowserReaderError(
        "BROWSER_MUTATION_RESULT_UNCERTAIN",
        "Browser close_tab returned without a confirmed close receipt; Codexless will not replay it automatically"
      );
    }
    const mappingRemoved = this.#reader.forgetTab(prepared.tabRef, prepared.providerTabId);
    return {
      status: "closed",
      browser: "chrome",
      action: { kind: "close_tab" },
      tab: publicBinding(binding),
      beforeUrl: result.beforeUrl ?? prepared.expectedUrl,
      mappingRemoved,
      note: "Exactly one prepared Chrome tab was closed through the official Tab.close() primitive after runtime, provider identity, and URL revalidation. The close is never batch-replayed after an uncertain result.",
    };
  }

  async prepareOpenTab({ url, cwd = this.#defaultCwd }) {
    const targetUrl = normalizeHttpUrl(url);
    await this.#reader.status({ cwd });
    return this.#storeAction({ kind: "open_tab", cwd: path.resolve(cwd), targetUrl, generation: this.#reader.generation }, {
      action: { kind: "open_tab", toUrl: targetUrl },
      nextAction: "Apply codex.browser_confirmation_policy and current user-authored task context, then execute this exact prepared action when authorized. The opaque ref is an action binding, not a permission token.",
    });
  }

  async openTab({ actionApprovalRef }) {
    const prepared = this.#consumeAction(actionApprovalRef, "open_tab");
    this.#assertGeneration(prepared);
    const result = await this.#reader.runBrowserJson({
      cwd: prepared.cwd,
      expectedGeneration: prepared.generation,
      mutationKind: "open_tab",
      title: "Execute prepared Chrome new tab",
      body: `
const __cxBrowser = await globalThis.__codexlessBrowserAgent.browsers.get("chrome");
let __cxTab = null;
let __cxPayload = null;
let __cxDispatched = false;
let __cxActionError = null;
let __cxFinalizeError = null;
try {
  __cxDispatched = true;
  __cxTab = await __cxBrowser.tabs.new();
  await __cxTab.goto(${JSON.stringify(prepared.targetUrl)});
  await __cxTab.playwright.waitForTimeout(250);
  __cxPayload = {
    requestedUrl: ${JSON.stringify(prepared.targetUrl)},
    afterUrl: (await __cxTab.url()) ?? null,
    afterTitle: (await __cxTab.title()) ?? null,
    snapshot: await __cxTab.playwright.domSnapshot(),
  };
} catch (__cxError) { __cxActionError = __cxError; }
finally {
  if (__cxTab) {
    try { await __cxBrowser.tabs.finalize({ keep: [{ tab: __cxTab, status: "deliverable" }] }); }
    catch (__cxError) { __cxFinalizeError = __cxError; }
  }
}
if (__cxDispatched && (__cxActionError || __cxFinalizeError)) {
  const __cxErr = __cxActionError ?? __cxFinalizeError;
  throw new Error("CODEXLESS_BROWSER_OPEN_TAB_RESULT_UNCERTAIN:" + (__cxErr instanceof Error ? __cxErr.message : String(__cxErr)));
}
if (__cxActionError) throw __cxActionError;
if (__cxFinalizeError) throw __cxFinalizeError;
nodeRepl.write(JSON.stringify(__cxPayload));`,
    });
    return mutationReceipt("opened", "open_tab", result, { requestedUrl: prepared.targetUrl });
  }

  async scroll({ tabRef, direction = "down", amount = "page", cwd = this.#defaultCwd, maxChars = 80_000 }) {
    if (!["down", "up"].includes(direction)) throw new BrowserReaderError("BROWSER_SCROLL_DIRECTION_INVALID", "direction must be down or up");
    if (!["small", "page"].includes(amount)) throw new BrowserReaderError("BROWSER_SCROLL_AMOUNT_INVALID", "amount must be small or page");
    const binding = await this.#reader.tabBinding({ tabRef, cwd });
    const keys = amount === "page"
      ? [direction === "down" ? "PageDown" : "PageUp"]
      : Array(6).fill(direction === "down" ? "ArrowDown" : "ArrowUp");
    const dispatch = await this.#reader.runBrowserJson({
      cwd: binding.cwd,
      expectedGeneration: binding.contextGeneration,
      mutationKind: "scroll",
      title: "Dispatch bounded Chrome scroll",
      body: claimBody(binding, `
const __cxBeforeUrl = (await __cxTab.url()) ?? __cxInfo.url ?? null;
if (__cxBeforeUrl !== ${JSON.stringify(binding.url)}) throw new Error("CODEXLESS_BROWSER_ACTION_URL_CHANGED");
const __cxBody = __cxTab.playwright.locator("body");
for (const __cxKey of ${JSON.stringify(keys)}) await __cxBody.press(__cxKey, { timeoutMs: 3000 });
await __cxTab.playwright.waitForTimeout(300);
__cxPayload = { beforeUrl: __cxBeforeUrl, afterUrl: (await __cxTab.url()) ?? null, keypresses: ${JSON.stringify(keys)}, scrollReturned: true };`),
    });
    this.#reader.updateTabState(tabRef, { url: dispatch?.afterUrl });
    const readback = await safeReadback(this.#reader, { tabRef, cwd: binding.cwd, maxChars });
    return {
      status: "scrolled", browser: "chrome", tab: readback.value?.tab ?? this.#reader.updateTabState(tabRef, {}),
      direction, amount, inputMethod: "body-keypress", keypresses: keys, dispatchStatus: "confirmed",
      beforeUrl: dispatch?.beforeUrl ?? binding.url, afterUrl: dispatch?.afterUrl ?? binding.url,
      readbackStatus: readback.ok ? "ok" : "unavailable", readbackError: readback.error,
      snapshot: readback.value?.snapshot ?? "", snapshotChars: readback.value?.snapshotChars ?? 0,
      snapshotTruncated: readback.value?.snapshotTruncated === true,
    };
  }

  async keypress({ tabRef, key, cwd = this.#defaultCwd, maxChars = 80_000 }) {
    if (!FIXED_KEYS.has(key)) throw new BrowserReaderError("BROWSER_KEYPRESS_KEY_INVALID", "key must be exactly Enter, Tab, or Escape");
    const binding = await this.#reader.tabBinding({ tabRef, cwd });
    const dispatch = await this.#reader.runBrowserJson({
      cwd: binding.cwd,
      expectedGeneration: binding.contextGeneration,
      mutationKind: "keypress",
      title: "Dispatch fixed Chrome keypress",
      body: claimBody(binding, `
const __cxBeforeUrl = (await __cxTab.url()) ?? __cxInfo.url ?? null;
if (__cxBeforeUrl !== ${JSON.stringify(binding.url)}) throw new Error("CODEXLESS_BROWSER_ACTION_URL_CHANGED");
await __cxTab.dom_cua.keypress({ keys: [${JSON.stringify(key)}] });
await __cxTab.playwright.waitForTimeout(250);
__cxPayload = { beforeUrl: __cxBeforeUrl, afterUrl: (await __cxTab.url()) ?? null, afterTitle: (await __cxTab.title()) ?? null, keypressReturned: true };`),
    });
    this.#reader.updateTabState(tabRef, { url: dispatch?.afterUrl, title: dispatch?.afterTitle });
    const readback = await safeReadback(this.#reader, { tabRef, cwd: binding.cwd, maxChars });
    return {
      status: "pressed", browser: "chrome", tab: readback.value?.tab ?? this.#reader.updateTabState(tabRef, {}), key,
      inputMethod: "focused-keypress", dispatchStatus: "confirmed", beforeUrl: dispatch?.beforeUrl ?? binding.url,
      afterUrl: dispatch?.afterUrl ?? binding.url, readbackStatus: readback.ok ? "ok" : "unavailable",
      readbackError: readback.error, snapshot: readback.value?.snapshot ?? "", snapshotChars: readback.value?.snapshotChars ?? 0,
      snapshotTruncated: readback.value?.snapshotTruncated === true,
    };
  }

  async prepareNavigate({ tabRef, url, cwd = this.#defaultCwd }) {
    const binding = await this.#reader.tabBinding({ tabRef, cwd });
    const targetUrl = normalizeHttpUrl(url);
    if (binding.url === targetUrl) throw new BrowserReaderError("BROWSER_NAVIGATE_SAME_URL", "The selected tab is already on the requested URL");
    return this.#storeAction({ kind: "navigate", cwd: binding.cwd, tabRef, providerTabId: binding.providerTabId, expectedUrl: binding.url, targetUrl, generation: binding.contextGeneration }, {
      action: { kind: "navigate", tab: publicBinding(binding), fromUrl: binding.url, toUrl: targetUrl },
    });
  }

  async navigate({ actionApprovalRef }) {
    const prepared = this.#consumeAction(actionApprovalRef, "navigate");
    const binding = await this.#revalidatePreparedTab(prepared);
    const result = await this.#reader.runBrowserJson({
      cwd: prepared.cwd,
      expectedGeneration: prepared.generation,
      mutationKind: "navigate",
      title: "Execute prepared Chrome navigation",
      body: claimBody(binding, `
const __cxBeforeUrl = (await __cxTab.url()) ?? __cxInfo.url ?? null;
if (__cxBeforeUrl !== ${JSON.stringify(prepared.expectedUrl)}) throw new Error("CODEXLESS_BROWSER_ACTION_URL_CHANGED");
await __cxTab.goto(${JSON.stringify(prepared.targetUrl)});
await __cxTab.playwright.waitForTimeout(250);
__cxPayload = { beforeUrl: __cxBeforeUrl, requestedUrl: ${JSON.stringify(prepared.targetUrl)}, afterUrl: (await __cxTab.url()) ?? null, afterTitle: (await __cxTab.title()) ?? null, snapshot: await __cxTab.playwright.domSnapshot() };`),
    });
    const tab = this.#reader.updateTabState(prepared.tabRef, { url: result?.afterUrl, title: result?.afterTitle });
    return mutationReceipt("navigated", "navigate", result, { tab, requestedUrl: prepared.targetUrl });
  }

  async prepareClick({ tabRef, role, name, text, cwd = this.#defaultCwd }) {
    const target = normalizeClickTarget({ role, name, text });
    const binding = await this.#reader.tabBinding({ tabRef, cwd });
    const locatorSource = prepareLocatorSourceForTarget(target);
    const result = await this.#reader.runBrowserJson({
      cwd: binding.cwd,
      expectedGeneration: binding.contextGeneration,
      title: "Prepare exact Chrome click",
      body: claimBody(binding, `
${locatorSource}
const __cxCount = await __cxLocator.count();
if (__cxCount !== 1) throw new Error("CODEXLESS_BROWSER_LOCATOR_COUNT:" + __cxCount);
if (!(await __cxLocator.isVisible())) throw new Error("CODEXLESS_BROWSER_LOCATOR_NOT_VISIBLE");
if (!(await __cxLocator.isEnabled())) throw new Error("CODEXLESS_BROWSER_LOCATOR_NOT_ENABLED");
__cxPayload = { url: (await __cxTab.url()) ?? __cxInfo.url ?? null, title: (await __cxTab.title()) ?? __cxInfo.title ?? null, count: __cxCount, textBinding: typeof __cxTextBinding === "undefined" ? null : __cxTextBinding };`),
    });
    const boundTarget = target.targetKind === "text" ? { ...target, textBinding: result?.textBinding ?? null } : target;
    if (target.targetKind === "text" && !boundTarget.textBinding) {
      throw new BrowserReaderError("BROWSER_CLICK_TEXT_BINDING_UNAVAILABLE", "Exact visible-text fallback did not produce a stable server-derived semantic binding");
    }
    return this.#storeAction({ kind: "click", cwd: binding.cwd, tabRef, providerTabId: binding.providerTabId, expectedUrl: result?.url ?? binding.url, target: boundTarget, generation: binding.contextGeneration }, {
      action: { kind: "click", tab: publicBinding(binding), ...publicTarget(boundTarget) },
    });
  }

  async click({ actionApprovalRef }) {
    const prepared = this.#consumeAction(actionApprovalRef, "click");
    const binding = await this.#revalidatePreparedTab(prepared);
    const locatorSource = locatorSourceForTarget(prepared.target);
    const result = await this.#reader.runBrowserJson({
      cwd: prepared.cwd,
      expectedGeneration: prepared.generation,
      mutationKind: "click",
      title: "Execute prepared Chrome click",
      body: claimBody(binding, `
const __cxBeforeUrl = (await __cxTab.url()) ?? __cxInfo.url ?? null;
if (__cxBeforeUrl !== ${JSON.stringify(prepared.expectedUrl)}) throw new Error("CODEXLESS_BROWSER_ACTION_URL_CHANGED");
${locatorSource}
const __cxCount = await __cxLocator.count();
if (__cxCount !== 1 || !(await __cxLocator.isVisible()) || !(await __cxLocator.isEnabled())) throw new Error("CODEXLESS_BROWSER_TARGET_CHANGED");
await __cxLocator.click({ timeoutMs: 5000 });
await __cxTab.playwright.waitForTimeout(250);
__cxPayload = { beforeUrl: __cxBeforeUrl, afterUrl: (await __cxTab.url()) ?? null, afterTitle: (await __cxTab.title()) ?? null, snapshot: await __cxTab.playwright.domSnapshot() };`),
    });
    const tab = this.#reader.updateTabState(prepared.tabRef, { url: result?.afterUrl, title: result?.afterTitle });
    return mutationReceipt("clicked", "click", result, { tab, target: prepared.target });
  }

  async prepareDownload({ tabRef, role, name, text, cwd = this.#defaultCwd }) {
    const prepared = await this.prepareClick({ tabRef, role, name, text, cwd });
    const stored = this.#actions.get(prepared.actionApprovalRef);
    stored.kind = "download";
    return { ...prepared, action: { ...prepared.action, kind: "download" } };
  }

  async download({ actionApprovalRef }) {
    const prepared = this.#consumeAction(actionApprovalRef, "download");
    const binding = await this.#revalidatePreparedTab(prepared);
    const locatorSource = locatorSourceForTarget(prepared.target);
    const result = await this.#reader.runBrowserJson({
      cwd: prepared.cwd,
      expectedGeneration: prepared.generation,
      mutationKind: "download",
      title: "Execute prepared Chrome download",
      body: claimBody(binding, `
const __cxBeforeUrl = (await __cxTab.url()) ?? __cxInfo.url ?? null;
if (__cxBeforeUrl !== ${JSON.stringify(prepared.expectedUrl)}) throw new Error("CODEXLESS_BROWSER_ACTION_URL_CHANGED");
${locatorSource}
const __cxCount = await __cxLocator.count();
if (__cxCount !== 1 || !(await __cxLocator.isVisible()) || !(await __cxLocator.isEnabled())) throw new Error("CODEXLESS_BROWSER_TARGET_CHANGED");
const __cxDownloadPromise = __cxTab.playwright.waitForEvent("download", { timeoutMs: 10000 });
await __cxLocator.click({ timeoutMs: 5000 });
const __cxDownload = await __cxDownloadPromise;
const __cxPath = typeof __cxDownload?.path === "function" ? await __cxDownload.path() : null;
__cxPayload = { beforeUrl: __cxBeforeUrl, afterUrl: (await __cxTab.url()) ?? null, downloadConfirmed: true, suggestedFilename: typeof __cxDownload?.suggestedFilename === "function" ? __cxDownload.suggestedFilename() : null, path: __cxPath ?? null };`),
    });
    if (result?.downloadConfirmed !== true) throw new BrowserReaderError("BROWSER_DOWNLOAD_RESULT_UNCERTAIN", "Browser download returned without a confirmed Chrome download event receipt");
    return { status: "downloaded", browser: "chrome", path: result?.path ?? null, suggestedFilename: result?.suggestedFilename ?? null, downloadConfirmed: true, beforeUrl: result?.beforeUrl ?? prepared.expectedUrl, afterUrl: result?.afterUrl ?? prepared.expectedUrl };
  }

  async prepareUpload({ tabRef, role, name, text, filePath, cwd = this.#defaultCwd }) {
    const target = normalizeClickTarget({ role, name, text });
    const binding = await this.#reader.tabBinding({ tabRef, cwd });
    const authorized = await resolveAuthorizedExistingFile({ authorityExecutor: this.#authorityExecutor, requestedPath: filePath, cwd: binding.cwd, access: "readOnly" });
    if (authorized.byteLength > MAX_UPLOAD_BYTES) throw new BrowserReaderError("BROWSER_UPLOAD_FILE_TOO_LARGE", `Upload file exceeds ${MAX_UPLOAD_BYTES} bytes`);
    const fingerprint = await fileFingerprint(authorized.path);
    const locatorSource = prepareLocatorSourceForTarget(target);
    const prepareResult = await this.#reader.runBrowserJson({
      cwd: binding.cwd,
      expectedGeneration: binding.contextGeneration,
      title: "Prepare exact Chrome upload",
      body: claimBody(binding, `
${locatorSource}
const __cxCount = await __cxLocator.count();
if (__cxCount !== 1 || !(await __cxLocator.isVisible()) || !(await __cxLocator.isEnabled())) throw new Error("CODEXLESS_BROWSER_TARGET_CHANGED");
__cxPayload = { url: (await __cxTab.url()) ?? __cxInfo.url ?? null, textBinding: typeof __cxTextBinding === "undefined" ? null : __cxTextBinding };`),
    });
    const boundTarget = target.targetKind === "text" ? { ...target, textBinding: prepareResult?.textBinding ?? null } : target;
    if (target.targetKind === "text" && !boundTarget.textBinding) {
      throw new BrowserReaderError("BROWSER_UPLOAD_TEXT_BINDING_UNAVAILABLE", "Exact visible-text upload target did not produce a stable server-derived semantic binding");
    }
    return this.#storeAction({ kind: "upload", cwd: binding.cwd, tabRef, providerTabId: binding.providerTabId, expectedUrl: prepareResult?.url ?? binding.url, target: boundTarget, generation: binding.contextGeneration, file: { path: authorized.path, ...fingerprint } }, {
      action: { kind: "upload", tab: publicBinding(binding), ...publicTarget(boundTarget), fileName: path.basename(authorized.path), fileBytes: fingerprint.byteLength, fileSha256: fingerprint.sha256 },
      nextAction: "Apply codex.browser_confirmation_policy before transmitting the prepared file. The prepared ref binds the canonical authorized file path, byte length, SHA-256 and exact page target; it is not permission evidence. Chrome must also permit file-URL access for this integration.",
    });
  }

  async upload({ actionApprovalRef }) {
    const prepared = this.#consumeAction(actionApprovalRef, "upload");
    const binding = await this.#revalidatePreparedTab(prepared);
    await assertAuthorizedFingerprint({ authorityExecutor: this.#authorityExecutor, file: prepared.file, cwd: prepared.cwd });
    const locatorSource = locatorSourceForTarget(prepared.target);
    const result = await this.#reader.runBrowserJson({
      cwd: prepared.cwd,
      expectedGeneration: prepared.generation,
      mutationKind: "upload",
      title: "Execute prepared Chrome upload",
      body: claimBody(binding, `
const __cxBeforeUrl = (await __cxTab.url()) ?? __cxInfo.url ?? null;
if (__cxBeforeUrl !== ${JSON.stringify(prepared.expectedUrl)}) throw new Error("CODEXLESS_BROWSER_ACTION_URL_CHANGED");
${locatorSource}
const __cxCount = await __cxLocator.count();
if (__cxCount !== 1 || !(await __cxLocator.isVisible()) || !(await __cxLocator.isEnabled())) throw new Error("CODEXLESS_BROWSER_TARGET_CHANGED");
const __cxChooserPromise = __cxTab.playwright.waitForEvent("filechooser", { timeoutMs: 10000 });
await __cxLocator.click({ timeoutMs: 5000 });
const __cxChooser = await __cxChooserPromise;
await __cxChooser.setFiles(${JSON.stringify(prepared.file.path)});
await __cxTab.playwright.waitForTimeout(250);
__cxPayload = { beforeUrl: __cxBeforeUrl, afterUrl: (await __cxTab.url()) ?? null, chooserConfirmed: true, setFilesReturned: true, snapshot: await __cxTab.playwright.domSnapshot() };`),
    });
    await assertAuthorizedFingerprint({ authorityExecutor: this.#authorityExecutor, file: prepared.file, cwd: prepared.cwd });
    return { status: "file_selected", browser: "chrome", chooserConfirmed: result?.chooserConfirmed === true, setFilesReturned: result?.setFilesReturned === true, fileName: path.basename(prepared.file.path), fileBytes: prepared.file.byteLength, fileSha256: prepared.file.sha256, beforeUrl: result?.beforeUrl ?? prepared.expectedUrl, afterUrl: result?.afterUrl ?? prepared.expectedUrl, postSnapshot: truncateSnapshot(result?.snapshot) };
  }

  async prepareFill({ tabRef, role, name, placeholder, text, cwd = this.#defaultCwd }) {
    const target = normalizeFillTarget({ role, name, placeholder });
    if (typeof text !== "string" || text.length > 100_000) throw new BrowserReaderError("BROWSER_FILL_TEXT_INVALID", "text must be a string of at most 100000 characters");
    const binding = await this.#reader.tabBinding({ tabRef, cwd });
    const locatorSource = locatorSourceForFill(target);
    const result = await this.#reader.runBrowserJson({
      cwd: binding.cwd,
      expectedGeneration: binding.contextGeneration,
      title: "Prepare exact Chrome fill",
      body: claimBody(binding, `
${locatorSource}
const __cxCount = await __cxLocator.count();
if (__cxCount !== 1 || !(await __cxLocator.isVisible()) || !(await __cxLocator.isEnabled())) throw new Error("CODEXLESS_BROWSER_TARGET_CHANGED");
__cxPayload = { url: (await __cxTab.url()) ?? __cxInfo.url ?? null };`),
    });
    return this.#storeAction({ kind: "fill", cwd: binding.cwd, tabRef, providerTabId: binding.providerTabId, expectedUrl: result?.url ?? binding.url, target, text, generation: binding.contextGeneration }, {
      action: { kind: "fill", tab: publicBinding(binding), ...target, textLength: text.length },
    });
  }

  async fill({ actionApprovalRef }) {
    const prepared = this.#consumeAction(actionApprovalRef, "fill");
    const binding = await this.#revalidatePreparedTab(prepared);
    const locatorSource = locatorSourceForFill(prepared.target);
    const result = await this.#reader.runBrowserJson({
      cwd: prepared.cwd,
      expectedGeneration: prepared.generation,
      mutationKind: "fill",
      title: "Execute prepared Chrome fill",
      body: claimBody(binding, `
const __cxBeforeUrl = (await __cxTab.url()) ?? __cxInfo.url ?? null;
if (__cxBeforeUrl !== ${JSON.stringify(prepared.expectedUrl)}) throw new Error("CODEXLESS_BROWSER_ACTION_URL_CHANGED");
${locatorSource}
const __cxCount = await __cxLocator.count();
if (__cxCount !== 1 || !(await __cxLocator.isVisible()) || !(await __cxLocator.isEnabled())) throw new Error("CODEXLESS_BROWSER_TARGET_CHANGED");
await __cxLocator.fill(${JSON.stringify(prepared.text)}, { timeoutMs: 5000 });
await __cxTab.playwright.waitForTimeout(150);
let __cxAfterValue = null;
try { __cxAfterValue = await __cxLocator.inputValue(); } catch {}
if (__cxAfterValue !== null && __cxAfterValue !== ${JSON.stringify(prepared.text)}) throw new Error("CODEXLESS_BROWSER_FILL_RESULT_UNCERTAIN:bound target value did not match prepared text");
__cxPayload = { beforeUrl: __cxBeforeUrl, afterUrl: (await __cxTab.url()) ?? null, afterTitle: (await __cxTab.title()) ?? null, afterValue: __cxAfterValue, snapshot: await __cxTab.playwright.domSnapshot() };`),
    });
    const tab = this.#reader.updateTabState(prepared.tabRef, { url: result?.afterUrl, title: result?.afterTitle });
    return { ...mutationReceipt("filled", "fill", result, { tab, target: prepared.target }), afterValue: result?.afterValue ?? null, textLength: prepared.text.length };
  }

  #storeAction(action, extra = {}) {
    this.#cleanup();
    const actionApprovalRef = `browser_action_${randomUUID()}`;
    const expiresAt = Date.now() + ACTION_TTL_MS;
    this.#actions.set(actionApprovalRef, { ...action, actionApprovalRef, expiresAt });
    return { status: "prepared", actionApprovalRef, expiresAt, ...extra, nextAction: extra.nextAction ?? "Apply codex.browser_confirmation_policy plus current user-authored task context, then execute the prepared action only when authorized. The opaque ref is an exact-action binding, not a permission token." };
  }

  #consumeAction(ref, kind) {
    this.#cleanup();
    if (typeof ref !== "string" || !ref.startsWith("browser_action_")) throw new BrowserReaderError("BROWSER_ACTION_REF_INVALID", "actionApprovalRef must be an opaque ref returned by the matching Browser prepare tool");
    const action = this.#actions.get(ref);
    if (!action || action.kind !== kind) throw new BrowserReaderError("BROWSER_ACTION_REF_EXPIRED", "actionApprovalRef is invalid, expired, already consumed, or belongs to another Browser action");
    this.#actions.delete(ref);
    return action;
  }

  #cleanup() {
    const now = Date.now();
    for (const [ref, action] of this.#actions.entries()) if (action.expiresAt <= now) this.#actions.delete(ref);
  }

  #assertGeneration(prepared) {
    if (prepared.generation !== this.#reader.generation) throw new BrowserReaderError("BROWSER_ACTION_RUNTIME_RESTARTED", "The prepared action belongs to an older Browser runtime generation and cannot be dispatched");
  }

  async #revalidatePreparedTab(prepared) {
    this.#assertGeneration(prepared);
    const binding = await this.#reader.tabBinding({ tabRef: prepared.tabRef, cwd: prepared.cwd });
    if (binding.providerTabId !== prepared.providerTabId) throw new BrowserReaderError("BROWSER_ACTION_TAB_STALE", "The prepared action no longer matches the current Browser tab");
    return binding;
  }
}

function claimBody(binding, actionBody) {
  return `
const __cxBrowser = await globalThis.__codexlessBrowserAgent.browsers.get("chrome");
const __cxOpenTabs = await __cxBrowser.user.openTabs();
const __cxInfo = __cxOpenTabs.find((tab) => tab.providerTabId === ${JSON.stringify(binding.providerTabId)});
if (!__cxInfo) throw new Error("CODEXLESS_BROWSER_TAB_STALE");
let __cxTab = null;
let __cxPayload = null;
try {
  const __cxOwnedTabs = await __cxBrowser.tabs.list();
  const __cxOwnedInfo = __cxOwnedTabs.find((tab) => String(tab.id) === String(__cxInfo.providerTabId));
  __cxTab = __cxOwnedInfo ? await __cxBrowser.tabs.get(__cxOwnedInfo.id) : await __cxBrowser.user.claimTab(__cxInfo);
  ${actionBody}
} finally {
  if (__cxTab && typeof __cxBrowser.tabs.finalize === "function") await __cxBrowser.tabs.finalize({ keep: [] });
}
nodeRepl.write(JSON.stringify(__cxPayload));`;
}

function normalizeHttpUrl(value) {
  if (typeof value !== "string" || !value.trim()) throw new BrowserReaderError("BROWSER_URL_REQUIRED", "url is required");
  let url;
  try { url = new URL(value); } catch { throw new BrowserReaderError("BROWSER_URL_INVALID", "url must be a valid absolute http(s) URL"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new BrowserReaderError("BROWSER_URL_INVALID", "url must use http or https");
  return url.href;
}

function normalizeClickTarget({ role, name, text }) {
  const hasText = typeof text === "string";
  if (hasText) {
    if (typeof role === "string" || typeof name === "string") throw new BrowserReaderError("BROWSER_CLICK_TARGET_CONFLICT", "Use exact visible text OR role+name, not both");
    const exactText = text.trim();
    if (!exactText || exactText.length > 2048) throw new BrowserReaderError("BROWSER_CLICK_TEXT_INVALID", "text must be 1..2048 characters");
    return { targetKind: "text", text: exactText, exact: true };
  }
  const exactRole = typeof role === "string" ? role.trim() : "";
  const exactName = typeof name === "string" ? name.trim() : "";
  if (!exactRole || !exactName) throw new BrowserReaderError("BROWSER_CLICK_TARGET_REQUIRED", "role and exact accessible name are required unless exact visible text mode is used");
  return { targetKind: "role", role: exactRole, name: exactName, exact: true };
}

function normalizeFillTarget({ role, name, placeholder }) {
  const exactRole = typeof role === "string" ? role.trim() : "";
  if (!FILL_ROLES.has(exactRole)) throw new BrowserReaderError("BROWSER_FILL_ROLE_INVALID", "role must be textbox or searchbox");
  const hasName = typeof name === "string" && name.length > 0;
  const hasPlaceholder = typeof placeholder === "string" && placeholder.length > 0;
  if (hasName === hasPlaceholder) throw new BrowserReaderError("BROWSER_FILL_TARGET_INVALID", "Provide exactly one of name or placeholder");
  return hasName ? { targetKind: "role", role: exactRole, name, exact: true } : { targetKind: "placeholder", role: exactRole, placeholder, exact: true };
}

function prepareLocatorSourceForTarget(target) {
  if (target.targetKind !== "text") {
    return `const __cxTextBinding = null;\nconst __cxLocator = __cxTab.playwright.getByRole(${JSON.stringify(target.role)}, { name: ${JSON.stringify(target.name)}, exact: true });`;
  }
  return `
const __cxTextCandidates = __cxTab.playwright.getByText(${JSON.stringify(target.text)}, { exact: true });
const __cxTextCandidateCount = await __cxTextCandidates.count();
const __cxVisibleCandidates = [];
for (let __cxI = 0; __cxI < __cxTextCandidateCount; __cxI += 1) {
  const __cxCandidate = __cxTextCandidates.nth(__cxI);
  if (await __cxCandidate.isVisible()) __cxVisibleCandidates.push(__cxCandidate);
}
if (__cxVisibleCandidates.length !== 1) throw new Error("CODEXLESS_BROWSER_VISIBLE_TEXT_COUNT:" + __cxVisibleCandidates.length);
const __cxTextCandidate = __cxVisibleCandidates[0];
const __cxTextMeta = await __cxTextCandidate.evaluate((element) => ({
  tagName: typeof element?.tagName === "string" ? element.tagName.toUpperCase() : null,
  explicitRole: typeof element?.getAttribute === "function" ? element.getAttribute("role") : null,
}));
const __cxDerivedRole = __cxTextMeta?.explicitRole === "link" || __cxTextMeta?.explicitRole === "button"
  ? __cxTextMeta.explicitRole
  : __cxTextMeta?.tagName === "A"
    ? "link"
    : __cxTextMeta?.tagName === "BUTTON"
      ? "button"
      : null;
if (!__cxDerivedRole) throw new Error("CODEXLESS_BROWSER_TEXT_BINDING_UNSTABLE");
const __cxLocator = __cxTab.playwright.getByRole(__cxDerivedRole, { name: ${JSON.stringify(target.text)}, exact: true });
const __cxStableCount = await __cxLocator.count();
if (__cxStableCount !== 1) throw new Error("CODEXLESS_BROWSER_TEXT_BINDING_AMBIGUOUS:" + __cxStableCount);
const __cxTextBinding = { kind: "role", role: __cxDerivedRole, name: ${JSON.stringify(target.text)} };`;
}

function locatorSourceForTarget(target) {
  if (target.targetKind === "text") {
    const binding = target.textBinding;
    if (!binding || binding.kind !== "role" || !["link", "button"].includes(binding.role) || binding.name !== target.text) {
      throw new BrowserReaderError("BROWSER_TEXT_BINDING_INVALID", "Prepared exact-text target has no valid stable server-derived role binding");
    }
    return `const __cxLocator = __cxTab.playwright.getByRole(${JSON.stringify(binding.role)}, { name: ${JSON.stringify(binding.name)}, exact: true });`;
  }
  return `const __cxLocator = __cxTab.playwright.getByRole(${JSON.stringify(target.role)}, { name: ${JSON.stringify(target.name)}, exact: true });`;
}

function publicTarget(target) {
  if (target?.targetKind === "text") return { targetKind: "text", text: target.text, exact: true };
  return { targetKind: "role", role: target.role, name: target.name, exact: true };
}

function locatorSourceForFill(target) {
  if (target.targetKind === "placeholder") return `const __cxLocator = __cxTab.playwright.getByPlaceholder(${JSON.stringify(target.placeholder)}, { exact: true });`;
  return `const __cxLocator = __cxTab.playwright.getByRole(${JSON.stringify(target.role)}, { name: ${JSON.stringify(target.name)}, exact: true });`;
}

function publicBinding(binding) {
  return { tabRef: binding.tabRef, title: binding.title ?? null, url: binding.url ?? null, lastOpened: binding.lastOpened ?? null };
}

function mutationReceipt(status, kind, result, extra = {}) {
  const snapshot = truncateSnapshot(result?.snapshot);
  return { status, browser: "chrome", action: { kind }, beforeUrl: result?.beforeUrl ?? null, afterUrl: result?.afterUrl ?? null, afterTitle: result?.afterTitle ?? null, postSnapshot: snapshot.text, postSnapshotChars: snapshot.chars, postSnapshotTruncated: snapshot.truncated, ...extra };
}

function truncateSnapshot(value) {
  const text = typeof value === "string" ? value : "";
  return { text: text.length > POST_SNAPSHOT_CHARS ? text.slice(0, POST_SNAPSHOT_CHARS) : text, chars: text.length, truncated: text.length > POST_SNAPSHOT_CHARS };
}

function detectImageMime(bytes) {
  const head = bytes.subarray(0, 8).toString("hex");
  if (head.startsWith("ffd8ff")) return "image/jpeg";
  if (head === "89504e470d0a1a0a") return "image/png";
  return null;
}

async function fileFingerprint(filePath) {
  const bytes = await readFile(filePath);
  return { byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function assertAuthorizedFingerprint({ authorityExecutor, file, cwd }) {
  let authorized;
  try {
    authorized = await resolveAuthorizedExistingFile({ authorityExecutor, requestedPath: file.path, cwd, access: "readOnly" });
  } catch (error) {
    throw new BrowserReaderError(
      "BROWSER_UPLOAD_SOURCE_AUTHORITY_CHANGED",
      "Prepared upload file is no longer the same authorized canonical file; re-prepare from current file authority",
      [error instanceof Error ? error.message : String(error)]
    );
  }
  if (path.resolve(authorized.path) !== path.resolve(file.path)) {
    throw new BrowserReaderError("BROWSER_UPLOAD_SOURCE_AUTHORITY_CHANGED", "Prepared upload file canonical target changed after preparation; re-prepare from current file authority");
  }
  const current = await fileFingerprint(authorized.path);
  if (current.byteLength !== file.byteLength || current.sha256 !== file.sha256) {
    throw new BrowserReaderError("BROWSER_UPLOAD_SOURCE_CHANGED", "Prepared upload file changed after preparation; re-prepare from current file state");
  }
}

async function safeReadback(reader, args) {
  try { return { ok: true, value: await reader.readTab(args), error: null }; }
  catch (error) { return { ok: false, value: null, error: { code: error?.code ?? "BROWSER_READBACK_FAILED", message: error instanceof Error ? error.message : String(error), nextActions: Array.isArray(error?.nextActions) ? error.nextActions : [] } }; }
}
