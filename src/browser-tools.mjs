import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const z = require("zod/v4");

export function registerBrowserPreviewTools(server, browser) {
  if (!browser) return;

  server.registerTool(
    "codex.browser_status",
    {
      title: "Check Existing-Login Chrome Browser",
      description:
        "Browser 0.1 read-only Preview. Check whether the current Codex Chrome Skill, node_repl body, and connected Chrome extension/backend are available for existing-login browser work. This starts no Codex model turn and inspects no page content. Website authentication is site-specific and is not inferred merely from extension connectivity.",
      inputSchema: z.object({
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional project cwd used only to resolve the current Codex Skill/MCP context; it is not browser navigation or a permission selector."),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.status(input))
  );

  server.registerTool(
    "codex.browser_confirmation_policy",
    {
      title: "Read Codex Browser Confirmation Policy",
      description:
        "Read-only Browser authority helper. Dynamically read the current Codex Chrome Skill's maintained `confirmations` policy so the caller can apply the same default risk taxonomy instead of maintaining a parallel hard-coded permission table. The response also carries this product's task-level verbal-confirmation guidance: ask at most once for a bounded browser task when the Codex policy indicates confirmation is needed, unless the task materially expands or a higher-level rule requires action-time confirmation. This tool does not start a Codex model turn, grant permission, inspect a page, or mutate browser state.",
      inputSchema: z.object({
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional project cwd used only to resolve the current Codex Chrome Skill/runtime. It is not a permission selector."),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => structured(() => browser.confirmationPolicy(input))
  );

  server.registerTool(
    "codex.browser_tabs",
    {
      title: "List Existing Chrome Tabs",
      description:
        "Browser 0.1 read-only Preview. List tabs already open in the user's connected Chrome session and return opaque tabRef values plus visible title/url/lastOpened. Toolwire automatically supplies the Codex Browser turn metadata required by the current Chrome runtime. This tool does not open, navigate, click, submit, or modify any tab.",
      inputSchema: z.object({
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional project cwd used to resolve the current Codex Browser runtime; it does not choose a browser profile or widen authority."),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.listTabs(input))
  );

  server.registerTool(
    "codex.browser_read",
    {
      title: "Read Existing Chrome Tab",
      description:
        "Browser 0.1 read-only Preview. Read a DOM snapshot from exactly one existing Chrome tabRef returned by codex.browser_tabs. The tab is claimed through the current Codex Chrome body only for read access; Toolwire does not navigate, click, type, submit, open a new tab, or expose raw provider tab IDs. The response includes the tab's current title/url so site-specific login redirects remain visible instead of being guessed.",
      inputSchema: z.object({
        tabRef: z.string().min(1).max(256)
          .describe("Opaque tab reference returned by codex.browser_tabs. Raw Chrome/provider tab IDs are not accepted."),
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional project cwd used to resolve the current Codex Browser runtime; it is not a browser navigation target or permission selector."),
        maxChars: z.number().int().min(1_000).max(200_000).default(80_000)
          .describe("Maximum DOM snapshot characters returned. Toolwire reports the original character count and whether truncation occurred."),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.readTab(input))
  );

  server.registerTool(
    "codex.browser_screenshot",
    {
      title: "Screenshot Existing Chrome Tab",
      description:
        "Browser 0.1 read-only visual Preview. Capture exactly the current visible viewport of one existing Chrome tabRef returned by codex.browser_tabs using the official tab.screenshot() API. The capture is viewport-only: callers cannot request full-page capture, crop rectangles, coordinates, selectors, JavaScript, viewport changes, or scrolling. Toolwire releases the claimed user tab after capture, validates a bounded JPEG/PNG payload from the official runtime, returns compact tab/image metadata as structured content, and returns the screenshot itself as MCP image content rather than base64 inside JSON. Use this when visual confirmation matters and a DOM snapshot alone is insufficient.",
      inputSchema: z.object({
        tabRef: z.string().min(1).max(256)
          .describe("Opaque tab reference returned by codex.browser_tabs. Raw Chrome/provider tab IDs are not accepted."),
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional project cwd used to resolve the current Codex Browser runtime; it is not a navigation target or permission selector."),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => imageResult(() => browser.screenshotTab(input))
  );

  server.registerTool(
    "codex.browser_prepare_close_tab",
    {
      title: "Prepare Exact Chrome Tab Close",
      description:
        "Browser lifecycle Preview. Prepare closing exactly one existing user-visible Chrome tab without closing or otherwise changing it. The tab must be identified only by an opaque tabRef returned by codex.browser_tabs; raw provider tab IDs, URLs, titles, indexes, selectors, and window targets are not accepted. Toolwire re-reads the current open-tab record and binds its provider identity, current URL, and current Workbench generation into a legacy-named single-use actionApprovalRef. Closing an existing tab can discard unsaved page input or other in-tab state, so the ref is only an exact-action binding and is not evidence of user approval. Apply codex.browser_confirmation_policy plus the current user-authored task context before execution; this tool itself is read-only and does not claim or close the tab.",
      inputSchema: z.object({
        tabRef: z.string().min(1).max(256)
          .describe("Opaque tab reference returned by codex.browser_tabs. Raw Chrome/provider tab IDs, URLs, titles, and indexes are not accepted."),
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional project cwd used only to resolve the current Codex Browser runtime; it is bound into the prepared action and cannot be changed at execution time."),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.prepareCloseTab(input))
  );

  server.registerTool(
    "codex.browser_close_tab",
    {
      title: "Execute Prepared Chrome Tab Close",
      description:
        "Browser lifecycle Preview. Close exactly one previously prepared existing Chrome tab using only the single-use actionApprovalRef returned by codex.browser_prepare_close_tab. The ref is not user-approval evidence. Before dispatch, apply codex.browser_confirmation_policy plus current user-authored task context; ordinary tabs may contain unsaved input, so preserve conservative confirmation semantics rather than assuming that close is harmless. Toolwire consumes the ref before dispatch, revalidates the same Workbench generation, provider identity, and current URL, claims that exact current open-tab object, calls the official Chrome Tab.close() exactly once, and then removes Toolwire's local tabRef/provider mapping after confirmed success. No raw provider id, tabRef, URL, title, index, window target, selector, JavaScript, reload/back/focus action, or replacement target is accepted at execution time. If the close dispatch result is uncertain, Toolwire fails visibly and never auto-retries the close.",
      inputSchema: z.object({
        actionApprovalRef: z.string().min(1).max(256)
          .describe("Legacy-named single-use exact-action reference returned by codex.browser_prepare_close_tab. It binds one exact tab close but does not itself prove user approval."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.closeTab(input))
  );

  server.registerTool(
    "codex.browser_prepare_open_tab",
    {
      title: "Prepare Exact Chrome New Tab",
      description:
        "Browser Operate Preview. Prepare opening exactly one new Chrome tab to one explicit http(s) URL without creating or navigating any tab. When the user goal is simply to reach/read a page and the exact destination is already reliably available from Browser-derived evidence, this direct route is preferred over simulating an intermediate click; do not guess route patterns. The exact normalized destination is stored in a legacy-named single-use actionApprovalRef. That ref is only an exact-action binding and is not evidence of user approval. Apply codex.browser_confirmation_policy plus current user-authored task context; do not ask for confirmation merely because a prepared ref exists. No existing tab, selector, JavaScript, click, fill, or scroll target is accepted.",
      inputSchema: z.object({
        url: z.string().min(1).max(8192)
          .describe("Exact destination URL. Toolwire accepts only explicit http:// or https:// URLs and binds the normalized URL into the prepared action."),
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional project cwd used only to resolve the current Codex Browser runtime; it is bound into the prepared action and cannot be changed at execution time."),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.prepareOpenTab(input))
  );

  server.registerTool(
    "codex.browser_open_tab",
    {
      title: "Execute Prepared Chrome New Tab",
      description:
        "Browser Operate Preview. Create exactly one new Chrome tab for a previously prepared explicit http(s) URL. The action receives only the single-use actionApprovalRef, uses official browser.tabs.new() + tab.goto(), reads back title/url/DOM, and finalizes the new tab as a user-visible deliverable. Call codex.browser_tabs afterward to obtain its normal opaque tabRef. Never auto-retry an uncertain new-tab result.",
      inputSchema: z.object({
        actionApprovalRef: z.string().min(1).max(256)
          .describe("Legacy-named single-use exact-action reference returned by codex.browser_prepare_open_tab. It binds the destination but does not itself prove user approval; apply the current Browser confirmation policy and task context before dispatch."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.openTab(input))
  );

  server.registerTool(
    "codex.browser_scroll",
    {
      title: "Scroll Existing Chrome Tab",
      description:
        "Browser Operate Preview. Scroll exactly one existing Chrome tab up or down by one bounded small/page step using an official Playwright keypress targeted at the fixed document body, then perform a separate read-only DOM readback. Page steps use PageDown/PageUp; small steps use a bounded ArrowDown/ArrowUp sequence. This intentionally avoids the Chrome Input.synthesizeScrollGesture path that can time out on real pages such as Reddit. The scroll receipt is independent from the readback: once the keypress scroll returns successfully, a later DOM-read failure is reported as readbackStatus=unavailable rather than turning the confirmed scroll into an uncertain mutation. No caller-supplied selectors, coordinates, node ids, or keys are accepted. It never clicks, types text, submits, or requests a new URL, but scrolling may naturally trigger lazy-loaded page content or site-side network activity.",
      inputSchema: z.object({
        tabRef: z.string().min(1).max(256)
          .describe("Opaque tab reference returned by codex.browser_tabs."),
        direction: z.enum(["down", "up"]).default("down")
          .describe("Scroll direction."),
        amount: z.enum(["small", "page"]).default("page")
          .describe("Bounded scroll distance: small is about 400 px and page is about 800 px."),
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional project cwd used only to resolve the current Codex Browser runtime."),
        maxChars: z.number().int().min(1_000).max(200_000).default(80_000)
          .describe("Maximum fresh DOM snapshot characters returned after the scroll."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.scrollTab(input))
  );

  server.registerTool(
    "codex.browser_keypress",
    {
      title: "Press Fixed Key in Existing Chrome Tab",
      description:
        "Browser Operate Preview. Press exactly one fixed Enter, Tab, or Escape key at the currently focused element in one existing Chrome tabRef using the official Chrome DOM CUA keypress API, then perform a separate read-only DOM readback. Callers cannot supply arbitrary key names, text, modifiers, repeats, selectors, coordinates, node ids, or JavaScript. Use an existing exact click/fill first when a specific control must be focused. Tab and Escape are ordinary bounded UI controls; Enter can activate or submit the focused control, so apply codex.browser_confirmation_policy plus the current task context before calling and ask only when that exact bounded task/action class requires confirmation. Once the keypress returns successfully, a later readback failure does not make the keypress uncertain and Toolwire never repeats it automatically.",
      inputSchema: z.object({
        tabRef: z.string().min(1).max(256)
          .describe("Opaque tab reference returned by codex.browser_tabs."),
        key: z.enum(["Enter", "Tab", "Escape"])
          .describe("Exactly one supported fixed key. Arbitrary keys, text and modifiers are not accepted."),
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional project cwd used only to resolve the current Codex Browser runtime."),
        maxChars: z.number().int().min(1_000).max(200_000).default(80_000)
          .describe("Maximum fresh DOM snapshot characters returned after the keypress."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.keypressTab(input))
  );

  server.registerTool(
    "codex.browser_prepare_navigate",
    {
      title: "Prepare Exact Chrome Navigation",
      description:
        "Browser Operate Preview. Prepare one direct navigation of exactly one existing Chrome tab to one explicit http(s) URL without dispatching it. When the user goal is simply to reach/read another page and the exact destination is already reliably available from Browser-derived evidence, this is the preferred path over clicking an intermediate UI element; do not guess route patterns. The tab must come from codex.browser_tabs. Preparing binds the current tab URL plus the exact destination into a legacy-named single-use actionApprovalRef and does not navigate, click, type, submit, open a new tab, or accept JavaScript/selectors. The ref is an exact-action binding, not a permission token. Apply codex.browser_confirmation_policy plus current user-authored task context; ordinary navigation must not trigger a redundant confirmation just because it uses prepare/execute.",
      inputSchema: z.object({
        tabRef: z.string().min(1).max(256)
          .describe("Opaque tab reference returned by codex.browser_tabs. Raw Chrome/provider tab IDs are not accepted."),
        url: z.string().min(1).max(8192)
          .describe("Exact destination URL. Toolwire accepts only explicit http:// or https:// URLs and binds the normalized URL into the prepared action."),
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional project cwd used only to resolve the current Codex Browser runtime; it is bound into the prepared action and cannot be changed at execution time."),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.prepareNavigate(input))
  );

  server.registerTool(
    "codex.browser_navigate",
    {
      title: "Execute Prepared Chrome Navigation",
      description:
        "Browser Operate Preview. Execute exactly one previously prepared existing-tab navigation identified only by a legacy-named single-use actionApprovalRef. The ref is not user-approval evidence. Before dispatch, the caller applies codex.browser_confirmation_policy plus current user-authored task context and asks only when that policy/task actually requires confirmation. Toolwire consumes the ref, revalidates the same current tab URL, calls the official Chrome tab.goto() for the bound http(s) destination, reads back the resulting URL/title/DOM, releases the claimed user tab, and never auto-retries an uncertain navigation. No tab, URL, selector, JavaScript, click, fill, scroll, or permission fields are accepted at execution time.",
      inputSchema: z.object({
        actionApprovalRef: z.string().min(1).max(256)
          .describe("Legacy-named single-use exact-action reference returned by codex.browser_prepare_navigate. It binds the exact navigation but is not itself user-approval evidence; apply the current Browser confirmation policy and task context before dispatch."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.navigate(input))
  );

  server.registerTool(
    "codex.browser_prepare_click",
    {
      title: "Prepare Exact Chrome Click",
      description:
        "Browser Operate Preview. Resolve exactly one visible enabled element in an existing Chrome tab and prepare one single click without dispatching it. Do not use click merely to imitate human navigation when the actual goal is page arrival and an exact destination URL is already reliably available from Browser-derived evidence; prefer direct navigate/open-tab in that case. Preferred targeting remains accessible role + exact accessible name. When a page repeats the same role/name control for many local items, role/name may additionally use one exact visible http(s) scopeUrl observed from the current Browser DOM: Toolwire finds exactly one visible link with that resolved URL, walks only a bounded server-fixed ancestor range, and selects the nearest ancestor containing exactly one matching local control. For real sites whose clickable cards expose only ordinary DOM text, callers may instead provide exact visible text. Exact-text preparation filters visibility candidate-by-candidate (so hidden duplicates do not create false ambiguity) and then requires one stable server-derived binding: link/button role, bounded onclick-property ancestor, or a bounded `.thread-card[data-thread-id]` ancestor whose exact thread id is stored and revalidated before execution. Caller input still exposes no CSS selector/JavaScript/coordinates/node ids/item indexes/ancestor depth; callers also cannot supply the server-recognized class or thread id. Exact-text and role/name modes are mutually exclusive; scopeUrl belongs only to role/name mode. The target tab must come from codex.browser_tabs. This tool is read-only, reuses the existing-login Chrome body, and returns a legacy-named single-use actionApprovalRef plus the exact target descriptor. The ref is only an exact-action binding. Use codex.browser_confirmation_policy and current task context to decide whether this click needs user confirmation; do not ask merely because the action is a click.",
      inputSchema: z.object({
        tabRef: z.string().min(1).max(256)
          .describe("Opaque tab reference returned by codex.browser_tabs. Raw Chrome/provider tab IDs are not accepted."),
        role: z.string().min(1).max(128).optional()
          .describe("Accessible role observed in current Browser DOM state, for example button or link. Use together with name, and omit text. Role/name remains the preferred semantic target mode."),
        name: z.string().min(1).max(2048).optional()
          .describe("Exact accessible name for role mode. Use together with role, and omit text. The target must resolve to exactly one visible enabled element, either globally or inside the optional scopeUrl."),
        scopeUrl: z.string().min(1).max(8192).optional()
          .describe("Optional exact visible http(s) link URL observed from the current Browser DOM, used only with role+name to bind one repeated local control to the nearest bounded ancestor scope. This is not a selector, node id, item index, or permission token."),
        text: z.string().min(1).max(2048).optional()
          .describe("Exact visible text fallback for clickable cards or other elements that expose no useful accessibility role. Use text alone without role/name; Toolwire uses exact getByText matching and still requires exactly one visible enabled target."),
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional project cwd used only to resolve the current Codex Browser runtime; it is bound into the prepared action and cannot be changed at execution time."),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.prepareClick(input))
  );

  server.registerTool(
    "codex.browser_click",
    {
      title: "Execute Prepared Chrome Click",
      description:
        "Browser Operate Preview. Execute exactly one previously prepared Chrome click identified only by a legacy-named single-use actionApprovalRef. The ref is not permission evidence. Before dispatch, apply codex.browser_confirmation_policy plus current user-authored task context: ordinary navigation/expansion clicks should not cause redundant prompts, while policy-covered external-side-effect clicks use the task-level verbal confirmation flow unless a higher-level rule requires otherwise. Toolwire consumes the action ref, revalidates the same tab URL plus the same unique visible enabled target (role/name or exact visible text) immediately before clicking, reads back current page state, releases the claimed user tab, and never auto-retries an uncertain click result. No tab, URL, selector, target text, role/name, coordinates, JavaScript, double-click, typing, scroll, navigation, or permission fields are accepted here; execution receives only the prepared opaque ref.",
      inputSchema: z.object({
        actionApprovalRef: z.string().min(1).max(256)
          .describe("Legacy-named single-use exact-action reference returned by codex.browser_prepare_click. It binds the exact target but is not itself user-approval evidence; apply the current Browser confirmation policy and task context before dispatch."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.click(input))
  );

  server.registerTool(
    "codex.browser_prepare_download",
    {
      title: "Prepare Exact Chrome Download",
      description:
        "Browser Operate Preview. Resolve exactly one visible enabled semantic download target in an existing Chrome tab and prepare one local download without clicking it. Targeting uses the same narrow role+exact accessible name or exact visible-text binding as prepared click; callers cannot provide CSS selectors, JavaScript, coordinates, node ids, or a local destination path. The tab must come from codex.browser_tabs. Preparing returns a legacy-named single-use actionApprovalRef that binds the current tab URL and exact target but is not permission evidence. Apply codex.browser_confirmation_policy plus current task context before dispatch; preparing does not create a local file.",
      inputSchema: z.object({
        tabRef: z.string().min(1).max(256)
          .describe("Opaque tab reference returned by codex.browser_tabs."),
        role: z.string().min(1).max(128).optional()
          .describe("Accessible role observed in current Browser DOM state, normally link or button. Use together with name and omit text."),
        name: z.string().min(1).max(2048).optional()
          .describe("Exact accessible name for role mode. The target must resolve to exactly one visible enabled element."),
        text: z.string().min(1).max(2048).optional()
          .describe("Exact visible-text fallback when the download control exposes no useful accessible role/name. Use text alone without role/name."),
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional project cwd used only to resolve the current Codex Browser runtime; it is bound into the prepared action."),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.prepareDownload(input))
  );

  server.registerTool(
    "codex.browser_download",
    {
      title: "Execute Prepared Chrome Download",
      description:
        "Browser Operate Preview. Execute exactly one prepared semantic download target and wait for the official Chrome Playwright download event. The execution receives only the single-use actionApprovalRef, revalidates the same tab URL and exact target before clicking, and never accepts a caller-supplied filesystem destination. When the runtime exposes download.path(), Toolwire returns Chrome's browser-managed local download path; it never opens, parses, executes, uploads, or trusts the downloaded file. If dispatch may have happened but no reliable download receipt returns, the result is fail-visible and must not be auto-retried because a local file may already exist.",
      inputSchema: z.object({
        actionApprovalRef: z.string().min(1).max(256)
          .describe("Legacy-named single-use exact-action reference returned by codex.browser_prepare_download. It binds the exact target but is not user-approval evidence."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.download(input))
  );

  server.registerTool(
    "codex.browser_prepare_upload",
    {
      title: "Prepare Exact Chrome Upload",
      description:
        "Browser Operate Preview. Prepare one authority-bounded local file for one exact semantic file-input/upload target in an existing Chrome tab. The local file path is resolved through Toolwire's Codex authority layer and its real path must remain inside the current trusted authority root; files above 100 MiB are refused in this Preview, and canonical path + byte length + SHA-256 are bound into the prepared record. This tool must not become an arbitrary host-file exfiltration path. Targeting uses role+exact accessible name or exact visible text, with no caller CSS selector, JavaScript, coordinates, node ids, or native-picker automation. The returned actionApprovalRef binds the current tab URL, exact target, and canonical authorized file. Preparing is read-only with respect to the webpage and does not expose file contents to it.",
      inputSchema: z.object({
        tabRef: z.string().min(1).max(256)
          .describe("Opaque tab reference returned by codex.browser_tabs."),
        role: z.string().min(1).max(128).optional()
          .describe("Accessible role for the current file input/upload control, commonly button. Use with name and omit text."),
        name: z.string().min(1).max(2048).optional()
          .describe("Exact accessible name for role mode. The target must resolve to exactly one visible enabled element."),
        text: z.string().min(1).max(2048).optional()
          .describe("Exact visible-text fallback for an upload control that exposes no useful role/name. Use text alone without role/name."),
        filePath: z.string().min(1).max(32_768)
          .describe("One existing local file path. Toolwire resolves it through Codex authority and refuses any real path outside the current trusted authority root."),
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional project cwd used to resolve both Browser runtime context and Codex file authority; it is not a permission selector."),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.prepareUpload(input))
  );

  server.registerTool(
    "codex.browser_upload",
    {
      title: "Execute Prepared Chrome Upload",
      description:
        "Browser Operate Preview. Execute one prepared authority-bounded local file handoff through the official Chrome filechooser/setFiles flow. Execution accepts only the single-use actionApprovalRef, revalidates the same tab URL and exact semantic target, then waits for a filechooser before applying the server-bound canonical file path. It never accepts an arbitrary local path at execution time. Toolwire revalidates the prepared canonical path + byte length + SHA-256 immediately before Browser dispatch and again after setFiles returns; this detects ordinary source drift but is not an OS write lock against an actively malicious concurrent writer. setFiles returning proves browser-side file selection/change delivery, not remote server acceptance; stronger upload-complete claims require page-state evidence. Uploading personal or sensitive files follows codex.browser_confirmation_policy and the user's bounded task authorization. Uncertain upload results are fail-visible and never auto-retried.",
      inputSchema: z.object({
        actionApprovalRef: z.string().min(1).max(256)
          .describe("Legacy-named single-use exact-action reference returned by codex.browser_prepare_upload. It binds the exact target and authorized file but is not user-approval evidence."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.upload(input))
  );

  server.registerTool(
    "codex.browser_prepare_fill",
    {
      title: "Prepare Exact Chrome Fill",
      description:
        "Browser Operate Preview. Prepare one exact text fill into an existing Chrome textbox/searchbox without changing the page. Preferred targeting is exact accessible role+name; when a real page exposes no accessible name, callers may instead provide either the exact visible placeholder or one exact visible http(s) scopeUrl observed from the current Browser DOM. scopeUrl mode is for locally unique unnamed editors inside repeated items: Toolwire finds exactly one visible link with that URL, walks only a bounded server-fixed ancestor range, and selects the nearest ancestor containing exactly one visible textbox/searchbox of the requested role. Name, placeholder, and scopeUrl modes are mutually exclusive. Callers still cannot provide selectors, node ids, item indexes, ancestor depth, JavaScript, or coordinates. The exact text is stored server-side in a legacy-named single-use actionApprovalRef. Preparing validates the current tab/URL and target but does not fill, click, press Enter, navigate, or submit. The ref is not permission evidence. Apply codex.browser_confirmation_policy plus task context: ordinary non-sensitive typing should not trigger a redundant prompt merely because it is Fill, while sensitive-data transmission or other policy-covered cases must follow the task confirmation rule before typing.",
      inputSchema: z.object({
        tabRef: z.string().min(1).max(256)
          .describe("Opaque tab reference returned by codex.browser_tabs. Raw Chrome/provider tab IDs are not accepted."),
        role: z.enum(["textbox", "searchbox"])
          .describe("Text-entry role observed in current Browser DOM state. Browser fill intentionally supports only textbox/searchbox."),
        name: z.string().min(1).max(2048).optional()
          .describe("Exact accessible name for preferred role/name mode. Supply name or placeholder, never both."),
        placeholder: z.string().min(1).max(2048).optional()
          .describe("Exact placeholder fallback for a textbox/searchbox that exposes no useful accessible name. Supply placeholder, name, or scopeUrl; never more than one target mode."),
        scopeUrl: z.string().min(1).max(8192).optional()
          .describe("Optional exact visible http(s) link URL observed from the current Browser DOM, used instead of name/placeholder to bind one locally unique unnamed textbox/searchbox to the nearest bounded ancestor scope. This is not a selector, node id, item index, or permission token."),
        text: z.string().max(20_000)
          .describe("Exact text to bind into the prepared action. No Enter, click, navigation, or submit is implied."),
        cwd: z.string().min(1).max(32_768).optional()
          .describe("Optional project cwd used only to resolve the current Codex Browser runtime; it is bound into the prepared action and cannot be changed at execution time."),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.prepareFill(input))
  );

  server.registerTool(
    "codex.browser_fill",
    {
      title: "Execute Prepared Chrome Fill",
      description:
        "Browser Operate Preview. Execute exactly one previously prepared textbox/searchbox fill identified only by a legacy-named single-use actionApprovalRef. The ref is not permission evidence. Before dispatch, apply codex.browser_confirmation_policy plus current user-authored task context; ask only when the policy/task actually requires confirmation, and use the task-level verbal flow rather than per-action prompting unless a higher-level rule requires otherwise. Toolwire consumes the action ref, revalidates the same tab URL plus unique visible enabled target, fills only the bound text, then re-resolves the same semantic target from fresh DOM before verification so rich editors may replace their activation shell without causing a stale-locator false negative. Verification stays narrow: exact fresh target value/rendered text, exactly one visible same-role target, or exactly one visible editable value inside a bounded local ancestor scope. If the first dispatch only activates a replacement editor, Toolwire may perform one internal repair fill only when the fresh bound target is proven blank and the exact prepared text is absent from fresh DOM. The first Browser execution then fully finalizes/releases its claimed tab before Toolwire starts one separate fresh Browser execution against the same provider tab and re-resolves the same bound role/name or role/placeholder target; this mirrors a true second interaction without requiring the caller to replay the mutation. Partial/ambiguous states, URL drift, failed fresh execution, or already-present text never auto-repair. Deterministic empty/no-write returns BROWSER_FILL_NOT_APPLIED; text-visible-but-bound-target-unproven returns BROWSER_FILL_VERIFICATION_UNAVAILABLE; true mutation uncertainty remains BROWSER_FILL_RESULT_UNCERTAIN. Multiple matches remain fail-closed and arbitrary matching page text is never accepted as proof. It then reads back current page state and releases the claimed user tab. It does not click, press Enter, navigate, or submit.",
      inputSchema: z.object({
        actionApprovalRef: z.string().min(1).max(256)
          .describe("Legacy-named single-use exact-action reference returned by codex.browser_prepare_fill. It binds the exact target/text but is not itself user-approval evidence; apply the current Browser confirmation policy and task context before dispatch."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => structured(() => browser.fill(input))
  );
}

async function imageResult(task) {
  try {
    const payload = await task();
    const data = payload?.dataBase64;
    const mimeType = payload?.mimeType;
    if (typeof data !== "string" || !data || typeof mimeType !== "string" || !mimeType.startsWith("image/")) {
      throw new Error("browser screenshot handler received no valid image payload");
    }
    const { dataBase64: _omitted, ...metadata } = payload;
    return {
      content: [
        { type: "text", text: JSON.stringify(metadata) },
        { type: "image", data, mimeType },
      ],
      structuredContent: metadata,
      isError: false,
    };
  } catch (error) {
    const payload = { error: error instanceof Error ? error.message : String(error) };
    if (typeof error?.code === "string") payload.errorCode = error.code;
    if (Array.isArray(error?.nextActions) && error.nextActions.every((value) => typeof value === "string")) {
      payload.nextActions = error.nextActions;
    }
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: true,
    };
  }
}

async function structured(task) {
  try {
    const payload = await task();
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: false,
    };
  } catch (error) {
    const payload = { error: error instanceof Error ? error.message : String(error) };
    if (typeof error?.code === "string") payload.errorCode = error.code;
    if (Array.isArray(error?.nextActions) && error.nextActions.every((value) => typeof value === "string")) {
      payload.nextActions = error.nextActions;
    }
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: true,
    };
  }
}
