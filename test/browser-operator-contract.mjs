import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexBrowserOperatorExecutor } from "../src/browser-operator-executor.mjs";
import { registerBrowserOperatorTools } from "../src/browser-operator-tools.mjs";

const root = mkdtempSync(path.join(os.tmpdir(), "codexless-browser-operator-"));
const otherRoot = mkdtempSync(path.join(os.tmpdir(), "codexless-browser-operator-other-"));
process.once("exit", () => {
  rmSync(root, { recursive: true, force: true });
  rmSync(otherRoot, { recursive: true, force: true });
});
const uploadPath = path.join(root, "upload.txt");
writeFileSync(uploadPath, "operator-upload-v1\n", "utf8");

class FakeReader {
  generation = 7;
  calls = [];
  tab = {
    tabRef: "browser_tab_contract",
    providerTabId: "provider-tab-contract",
    contextGeneration: 7,
    title: "Example",
    url: "https://example.com/",
    lastOpened: null,
    cwd: root,
  };

  async status() { return { status: "ok" }; }
  async tabBinding({ tabRef }) {
    assert.equal(tabRef, this.tab.tabRef);
    return { ...this.tab };
  }
  updateTabState(tabRef, patch = {}) {
    assert.equal(tabRef, this.tab.tabRef);
    this.tab = { ...this.tab, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) };
    return { tabRef: this.tab.tabRef, title: this.tab.title, url: this.tab.url, lastOpened: this.tab.lastOpened };
  }
  forgetTab(tabRef, providerTabId = null) {
    assert.equal(tabRef, this.tab.tabRef);
    if (providerTabId !== null) assert.equal(providerTabId, this.tab.providerTabId);
    this.forgottenTab = { tabRef, providerTabId };
    return true;
  }
  async readTab() {
    return { status: "ok", tab: this.updateTabState(this.tab.tabRef, {}), snapshot: "after", snapshotChars: 5, snapshotTruncated: false };
  }
  async runBrowserJson(request) {
    this.calls.push(request);
    if (request.title.includes("confirmation policy")) return { policy: "Confirm external side effects when required." };
    if (request.title.includes("Chrome viewport")) return { title: "Example", url: this.tab.url, byteLength: 4, dataBase64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64") };
    if (request.title === "Prepare exact Chrome click" || request.title === "Prepare exact Chrome upload") {
      return { url: this.tab.url, title: this.tab.title, count: 1, textBinding: { kind: "role", role: "button", name: "Continue" } };
    }
    if (request.title === "Prepare exact Chrome fill") return { url: this.tab.url };
    if (request.title === "Prepare exact Chrome tab close") return { url: this.tab.url, title: this.tab.title, lastOpened: this.tab.lastOpened };
    if (request.title === "Execute prepared Chrome tab close") return { beforeUrl: this.tab.url, closed: true };
    if (request.title === "Execute prepared Chrome new tab") return { afterUrl: "https://example.net/", afterTitle: "Opened", snapshot: "opened" };
    if (request.title === "Execute prepared Chrome navigation") return { beforeUrl: this.tab.url, afterUrl: "https://example.net/", afterTitle: "Navigated", snapshot: "navigated" };
    if (request.title === "Execute prepared Chrome click") return { beforeUrl: this.tab.url, afterUrl: this.tab.url, afterTitle: this.tab.title, snapshot: "clicked" };
    if (request.title === "Execute prepared Chrome download") return { beforeUrl: this.tab.url, afterUrl: this.tab.url, downloadConfirmed: true, suggestedFilename: "download.txt", path: path.join(root, "download.txt") };
    if (request.title === "Execute prepared Chrome upload") return { beforeUrl: this.tab.url, afterUrl: this.tab.url, chooserConfirmed: true, setFilesReturned: true, snapshot: "selected" };
    if (request.title === "Execute prepared Chrome fill") return { beforeUrl: this.tab.url, afterUrl: this.tab.url, afterTitle: this.tab.title, afterValue: "hello", snapshot: "filled" };
    if (request.title === "Dispatch bounded Chrome scroll") return { beforeUrl: this.tab.url, afterUrl: this.tab.url, scrollReturned: true };
    if (request.title === "Dispatch fixed Chrome keypress") return { beforeUrl: this.tab.url, afterUrl: this.tab.url, afterTitle: this.tab.title, keypressReturned: true };
    throw new Error(`unexpected fake Browser call: ${request.title}`);
  }
}

const fakeReader = new FakeReader();
let trustedAncestor = root;
const authorityExecutor = {
  async resolveAuthority({ cwd = root }) {
    return { effectiveCwd: cwd, trustedAncestor, permissionProfile: "contract" };
  },
};
const operator = new CodexBrowserOperatorExecutor({ reader: fakeReader, authorityExecutor, defaultCwd: root });

const policy = await operator.confirmationPolicy({ cwd: root });
assert.equal(policy.status, "ok");
assert.match(policy.codexPolicy, /external side effects/i);

const shot = await operator.screenshot({ tabRef: fakeReader.tab.tabRef, cwd: root });
assert.equal(shot.mimeType, "image/jpeg");
assert.equal(shot.byteLength, 4);

const preparedClose = await operator.prepareCloseTab({ tabRef: fakeReader.tab.tabRef, cwd: root });
assert.equal(preparedClose.action.kind, "close_tab");
assert.equal(preparedClose.action.expectedUrl, "https://example.com/");
const closed = await operator.closeTab({ actionApprovalRef: preparedClose.actionApprovalRef });
assert.equal(closed.status, "closed");
assert.equal(closed.mappingRemoved, true);
assert.equal(fakeReader.calls.at(-1).mutationKind, "close_tab");
assert.match(fakeReader.calls.at(-1).body, /\.close\(\)/);
assert.doesNotMatch(fakeReader.calls.at(-1).body, /finalize\(\{ keep: \[\] \}\)[\s\S]*__cxDispatchAttempted = true/, "close must not rely on a post-dispatch finalize path");
await assert.rejects(() => operator.closeTab({ actionApprovalRef: preparedClose.actionApprovalRef }), /expired|consumed/i, "close refs are single-use");

await assert.rejects(() => operator.prepareOpenTab({ url: "file:///tmp/nope", cwd: root }), /http|url/i);
const preparedOpen = await operator.prepareOpenTab({ url: "https://example.net/", cwd: root });
const opened = await operator.openTab({ actionApprovalRef: preparedOpen.actionApprovalRef });
assert.equal(opened.status, "opened");
await assert.rejects(() => operator.openTab({ actionApprovalRef: preparedOpen.actionApprovalRef }), /expired|consumed/i, "single-use prepared refs must not replay");

fakeReader.tab.url = "https://example.com/";
const preparedNavigate = await operator.prepareNavigate({ tabRef: fakeReader.tab.tabRef, url: "https://example.net/", cwd: root });
const navigated = await operator.navigate({ actionApprovalRef: preparedNavigate.actionApprovalRef });
assert.equal(navigated.status, "navigated");
assert.equal(fakeReader.calls.at(-1).mutationKind, "navigate");
fakeReader.tab.url = "https://example.com/";

await assert.rejects(() => operator.prepareClick({ tabRef: fakeReader.tab.tabRef, role: "button", name: "Continue", text: "Continue", cwd: root }), /either|both|conflict/i);
const preparedTextClick = await operator.prepareClick({ tabRef: fakeReader.tab.tabRef, text: "Continue", cwd: root });
assert.deepEqual(preparedTextClick.action, {
  kind: "click",
  tab: { tabRef: fakeReader.tab.tabRef, title: fakeReader.tab.title, url: fakeReader.tab.url, lastOpened: fakeReader.tab.lastOpened },
  targetKind: "text",
  text: "Continue",
  exact: true,
});
const clicked = await operator.click({ actionApprovalRef: preparedTextClick.actionApprovalRef });
assert.equal(clicked.status, "clicked");
const clickExecuteSource = fakeReader.calls.at(-1).body;
assert.match(clickExecuteSource, /getByRole\("button"/);
assert.doesNotMatch(clickExecuteSource, /getByText\("Continue"/, "execution must use the server-derived stable role binding, not re-resolve arbitrary visible text");

await assert.rejects(() => operator.keypress({ tabRef: fakeReader.tab.tabRef, key: "Control+A", cwd: root }), /Enter, Tab, or Escape/);
const pressed = await operator.keypress({ tabRef: fakeReader.tab.tabRef, key: "Enter", cwd: root });
assert.equal(pressed.status, "pressed");
await assert.rejects(() => operator.scroll({ tabRef: fakeReader.tab.tabRef, direction: "sideways", cwd: root }), /direction/);
assert.equal((await operator.scroll({ tabRef: fakeReader.tab.tabRef, direction: "down", amount: "page", cwd: root })).status, "scrolled");

await assert.rejects(() => operator.prepareFill({ tabRef: fakeReader.tab.tabRef, role: "button", name: "X", text: "hello", cwd: root }), /textbox|searchbox/);
await assert.rejects(() => operator.prepareFill({ tabRef: fakeReader.tab.tabRef, role: "textbox", name: "Message", placeholder: "Type", text: "hello", cwd: root }), /exactly one/i);
const preparedFill = await operator.prepareFill({ tabRef: fakeReader.tab.tabRef, role: "textbox", name: "Message", text: "hello", cwd: root });
assert.equal((await operator.fill({ actionApprovalRef: preparedFill.actionApprovalRef })).status, "filled");
assert.equal(fakeReader.calls.at(-1).mutationKind, "fill");

const preparedDownload = await operator.prepareDownload({ tabRef: fakeReader.tab.tabRef, role: "link", name: "Download", cwd: root });
const downloaded = await operator.download({ actionApprovalRef: preparedDownload.actionApprovalRef });
assert.equal(downloaded.downloadConfirmed, true);
assert.equal(fakeReader.calls.at(-1).mutationKind, "download");

const preparedUpload = await operator.prepareUpload({ tabRef: fakeReader.tab.tabRef, role: "button", name: "Upload", filePath: uploadPath, cwd: root });
writeFileSync(uploadPath, "operator-upload-v2-drift\n", "utf8");
const callsBeforeDriftedUpload = fakeReader.calls.length;
await assert.rejects(() => operator.upload({ actionApprovalRef: preparedUpload.actionApprovalRef }), /changed after preparation/i);
assert.equal(fakeReader.calls.length, callsBeforeDriftedUpload, "drifted upload source must fail before Browser dispatch");

writeFileSync(uploadPath, "operator-upload-v3\n", "utf8");
const preparedAuthorityDrift = await operator.prepareUpload({ tabRef: fakeReader.tab.tabRef, role: "button", name: "Upload", filePath: uploadPath, cwd: root });
const callsBeforeAuthorityDrift = fakeReader.calls.length;
trustedAncestor = otherRoot;
await assert.rejects(() => operator.upload({ actionApprovalRef: preparedAuthorityDrift.actionApprovalRef }), /authorized canonical file|authority/i);
assert.equal(fakeReader.calls.length, callsBeforeAuthorityDrift, "upload must revalidate trusted-root authority before Browser dispatch");
trustedAncestor = root;

const preparedUpload2 = await operator.prepareUpload({ tabRef: fakeReader.tab.tabRef, role: "button", name: "Upload", filePath: uploadPath, cwd: root });
const uploaded = await operator.upload({ actionApprovalRef: preparedUpload2.actionApprovalRef });
assert.equal(uploaded.status, "file_selected");
assert.equal(uploaded.chooserConfirmed, true);
assert.equal(uploaded.setFilesReturned, true);
assert.equal(fakeReader.calls.at(-1).mutationKind, "upload");

const collected = new Map();
registerBrowserOperatorTools({ registerTool(name, options) { collected.set(name, options); } }, operator);
assert.equal(collected.size, 18);
assert.equal(collected.has("codex.browser_prepare_close_tab"), true);
assert.equal(collected.has("codex.browser_close_tab"), true);
for (const [toolName, options] of collected) {
  const schemaText = String(options?.inputSchema ?? "");
  assert.doesNotMatch(schemaText, /selector|javascript|coordinate|providerTabId/i, `${toolName} must not expose raw Browser internals`);
}

console.log("public Browser Operator bounded contract PASS");
