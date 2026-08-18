import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const z = require("zod/v4");

const cwd = z.string().min(1).max(32_768).optional();
const tabRef = z.string().min(1).max(256).describe("Opaque tabRef returned by codex.browser_tabs; raw provider IDs are not accepted.");
const actionApprovalRef = z.string().min(1).max(256).describe("Single-use exact-action binding returned by the matching Browser prepare tool. It is not permission evidence.");
const role = z.string().min(1).max(128).optional();
const name = z.string().min(1).max(2_048).optional();
const textTarget = z.string().min(1).max(2_048).optional();

export function registerBrowserOperatorTools(server, browser) {
  if (!browser) return;

  register(server, "codex.browser_confirmation_policy", {
    title: "Read Current Codex Browser Confirmation Policy",
    description: "Read the currently installed Codex Chrome Skill confirmation policy. This is read-only and does not grant permission. Apply it together with the user's bounded task context; prepared Browser refs are exact-action bindings, not approval tokens.",
    inputSchema: z.object({ cwd }).strict(),
    annotations: ro(true),
  }, (input) => browser.confirmationPolicy(input));

  server.registerTool(
    "codex.browser_screenshot",
    {
      title: "Capture Current Chrome Viewport",
      description: "Read-only viewport screenshot of one existing tabRef through the official Browser screenshot primitive. Full-page, clip, selector, coordinate, JavaScript and viewport-control inputs are not exposed.",
      inputSchema: z.object({ tabRef, cwd }).strict(),
      annotations: ro(true),
    },
    async (input) => {
      try {
        const payload = await browser.screenshot(input);
        const { dataBase64, ...structuredContent } = payload;
        return {
          content: [
            { type: "text", text: JSON.stringify(structuredContent) },
            { type: "image", data: dataBase64, mimeType: payload.mimeType },
          ],
          structuredContent,
          isError: false,
        };
      } catch (error) {
        return structuredError(error);
      }
    }
  );

  register(server, "codex.browser_prepare_close_tab", {
    title: "Prepare Exact Chrome Tab Close",
    description: "Read-only preparation for closing exactly one existing tabRef. Codexless re-reads the current tab and binds provider identity, URL and Browser runtime generation into one single-use opaque ref. A normal tab may contain unsaved input, so the ref is not permission evidence; apply the current Browser confirmation policy and task context before execution.",
    inputSchema: z.object({ tabRef, cwd }).strict(), annotations: ro(true),
  }, (input) => browser.prepareCloseTab(input));
  register(server, "codex.browser_close_tab", {
    title: "Close Prepared Chrome Tab",
    description: "Close exactly one previously prepared existing Chrome tab. Codexless consumes the single-use ref before dispatch, revalidates runtime generation, provider identity and current URL, calls the official Tab.close() primitive exactly once, and never blindly retries an uncertain close. No raw tab id, URL, selector, coordinate, JavaScript, window target or batch-close input is accepted.",
    inputSchema: z.object({ actionApprovalRef }).strict(), annotations: mutate(),
  }, (input) => browser.closeTab(input));

  register(server, "codex.browser_prepare_open_tab", {
    title: "Prepare Exact New Chrome Tab",
    description: prepared("one new Chrome tab to one explicit http(s) URL"),
    inputSchema: z.object({ url: z.string().url().max(32_768), cwd }).strict(), annotations: ro(true),
  }, (input) => browser.prepareOpenTab(input));
  register(server, "codex.browser_open_tab", {
    title: "Open Prepared Chrome Tab",
    description: execute("new-tab action"), inputSchema: z.object({ actionApprovalRef }).strict(), annotations: mutate(),
  }, (input) => browser.openTab(input));

  register(server, "codex.browser_scroll", {
    title: "Scroll Existing Chrome Tab",
    description: "Dispatch one bounded page/small scroll on an existing tabRef using fixed PageDown/PageUp or ArrowDown/ArrowUp keypresses, then attempt a separate readback. No coordinates, selectors, JavaScript, wheel deltas or arbitrary keys are accepted. Apply the current Browser confirmation policy and task context before dispatch.",
    inputSchema: z.object({ tabRef, direction: z.enum(["down", "up"]).default("down"), amount: z.enum(["small", "page"]).default("page"), cwd, maxChars: z.number().int().min(1_000).max(200_000).default(80_000) }).strict(), annotations: mutate(),
  }, (input) => browser.scroll(input));

  register(server, "codex.browser_keypress", {
    title: "Press Fixed Browser Key",
    description: "Press exactly one Enter, Tab or Escape at the page's current focus, then attempt a separate readback. Arbitrary keys, text, modifiers, repeats, selectors, coordinates and JavaScript are not exposed. Enter may activate/submit the focused control, so apply the current confirmation policy and task context before dispatch.",
    inputSchema: z.object({ tabRef, key: z.enum(["Enter", "Tab", "Escape"]), cwd, maxChars: z.number().int().min(1_000).max(200_000).default(80_000) }).strict(), annotations: mutate(),
  }, (input) => browser.keypress(input));

  register(server, "codex.browser_prepare_navigate", {
    title: "Prepare Exact Chrome Navigation", description: prepared("navigation of one existing tabRef to one explicit http(s) URL"),
    inputSchema: z.object({ tabRef, url: z.string().url().max(32_768), cwd }).strict(), annotations: ro(true),
  }, (input) => browser.prepareNavigate(input));
  register(server, "codex.browser_navigate", {
    title: "Navigate Prepared Chrome Tab", description: execute("existing-tab navigation"), inputSchema: z.object({ actionApprovalRef }).strict(), annotations: mutate(),
  }, (input) => browser.navigate(input));

  register(server, "codex.browser_prepare_click", {
    title: "Prepare Exact Chrome Click",
    description: "Read-only preparation for exactly one visible enabled semantic click target in an existing tabRef. Use role+exact accessible name or exact visible text. Caller CSS selectors, node IDs, indexes, JavaScript and coordinates are not accepted. The returned ref is not permission evidence.",
    inputSchema: z.object({ tabRef, role, name, text: textTarget, cwd }).strict(), annotations: ro(true),
  }, (input) => browser.prepareClick(input));
  register(server, "codex.browser_click", {
    title: "Execute Prepared Chrome Click", description: execute("semantic click"), inputSchema: z.object({ actionApprovalRef }).strict(), annotations: mutate(),
  }, (input) => browser.click(input));

  register(server, "codex.browser_prepare_download", {
    title: "Prepare Exact Chrome Download",
    description: "Read-only preparation for one semantic download target. Use role+exact accessible name or exact visible text; no local destination path is accepted. Execution requires a real Chrome download event receipt and never blindly replays an uncertain mutation.",
    inputSchema: z.object({ tabRef, role, name, text: textTarget, cwd }).strict(), annotations: ro(true),
  }, (input) => browser.prepareDownload(input));
  register(server, "codex.browser_download", {
    title: "Execute Prepared Chrome Download", description: execute("download"), inputSchema: z.object({ actionApprovalRef }).strict(), annotations: mutate(),
  }, (input) => browser.download(input));

  register(server, "codex.browser_prepare_upload", {
    title: "Prepare Authority-Bounded Chrome Upload",
    description: "Read-only preparation for one semantic file-upload target plus one existing local file inside the current Codex trusted authority root. Codexless binds canonical path, byte length and SHA-256 before Browser dispatch. Chrome file-URL access must be enabled for this integration. File selection proves browser-side selection only, not remote acceptance.",
    inputSchema: z.object({ tabRef, role, name, text: textTarget, filePath: z.string().min(1).max(32_768), cwd }).strict(), annotations: ro(true),
  }, (input) => browser.prepareUpload(input));
  register(server, "codex.browser_upload", {
    title: "Execute Prepared Chrome Upload", description: execute("authority-bounded upload"), inputSchema: z.object({ actionApprovalRef }).strict(), annotations: mutate(),
  }, (input) => browser.upload(input));

  register(server, "codex.browser_prepare_fill", {
    title: "Prepare Exact Chrome Fill",
    description: "Read-only preparation for one exact textbox/searchbox fill. Target by role plus exact accessible name or exact placeholder; caller selectors, node IDs, indexes, JavaScript and coordinates are not accepted. The bound text stays server-side in the single-use action ref.",
    inputSchema: z.object({ tabRef, role: z.enum(["textbox", "searchbox"]), name: z.string().max(2_048).optional(), placeholder: z.string().max(2_048).optional(), text: z.string().max(100_000), cwd }).strict(), annotations: ro(true),
  }, (input) => browser.prepareFill(input));
  register(server, "codex.browser_fill", {
    title: "Execute Prepared Chrome Fill", description: execute("textbox/searchbox fill"), inputSchema: z.object({ actionApprovalRef }).strict(), annotations: mutate(),
  }, (input) => browser.fill(input));
}

function register(server, toolName, options, handler) {
  server.registerTool(toolName, options, async (input) => {
    try {
      const payload = await handler(input);
      return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: false };
    } catch (error) {
      return structuredError(error);
    }
  });
}

function structuredError(error) {
  const payload = { error: error instanceof Error ? error.message : String(error) };
  if (typeof error?.code === "string") payload.errorCode = error.code;
  if (Array.isArray(error?.nextActions)) payload.nextActions = error.nextActions;
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
}

function ro(openWorldHint = true) { return { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint }; }
function mutate() { return { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }; }
function prepared(action) { return `Prepare ${action} without dispatching it. The returned single-use opaque ref binds exact current state/action but is not proof of user approval; apply codex.browser_confirmation_policy plus current task context before execution.`; }
function execute(action) { return `Execute exactly one previously prepared ${action} from its single-use opaque ref. The ref is consumed before dispatch. Codexless revalidates bound state, never accepts raw selectors/coordinates/JavaScript at execution time, and does not blindly replay uncertain mutations.`; }
