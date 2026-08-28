// Surface/version strings below are external compatibility ids, not product names.
export const STABLE_SERVER_VERSION = "0.0.2-p4";
export const STABLE_SURFACE_VERSION = "p4-command-v1";
export const STABLE_SOURCE_TOOL_COUNT = 1;

export const WORKBENCH_SERVER_VERSION = "0.0.56-agent-task-card-v13-browser-close35";
export const WORKBENCH_SURFACE_VERSION = "p4-workbench-agent-task-card-v13-browser-close35";
export const WORKBENCH_SOURCE_TOOL_COUNT_WITH_CUA = 49;
export const WORKBENCH_SOURCE_TOOL_COUNT_WITHOUT_CUA = 44;

export const PUBLIC_SERVER_VERSION = "0.1.1-preview.5";
export const PUBLIC_SURFACE_VERSION = "codexless-public-preview-v1";
export const PUBLIC_TOOL_ALLOWLIST = Object.freeze([
  "codex.command_exec",
  "codex.project_context",
  "codex.account_preflight",
  "codex.skill_list",
  "codex.skill_read",
  "codex.read_many",
  "codex.precise_edit",
  "codex.browser_status",
  "codex.browser_confirmation_policy",
  "codex.browser_tabs",
  "codex.browser_read",
  "codex.browser_screenshot",
  "codex.browser_prepare_close_tab",
  "codex.browser_close_tab",
  "codex.browser_prepare_open_tab",
  "codex.browser_open_tab",
  "codex.browser_scroll",
  "codex.browser_keypress",
  "codex.browser_prepare_navigate",
  "codex.browser_navigate",
  "codex.browser_prepare_click",
  "codex.browser_click",
  "codex.browser_prepare_download",
  "codex.browser_download",
  "codex.browser_prepare_upload",
  "codex.browser_upload",
  "codex.browser_prepare_fill",
  "codex.browser_fill",
  "codex.call_profile",
  "codex.model_list",
  "codex.agent_start",
  "codex.agent_card_render",
  "codex.agent_card_state",
  "codex.agent_show",
  "codex.agent_steer",
  "codex.agent_send",
  "codex.agent_decline",
  "codex.agent_commit",
  "codex.agent_portable_commit",
  "codex.agent_portable_decline",
  "codex.agent_approve",
  "codex.agent_reject",
  "codex.agent_cancel",
]);
export const PUBLIC_SOURCE_TOOL_COUNT = PUBLIC_TOOL_ALLOWLIST.length;
export const PUBLIC_TOOL_NAMES = PUBLIC_TOOL_ALLOWLIST;

// Historical exports retained for downstream tests/callers that imported the prototype names.
export const PUBLIC_PREVIEW_SERVER_VERSION = PUBLIC_SERVER_VERSION;
export const PUBLIC_PREVIEW_SURFACE_VERSION = PUBLIC_SURFACE_VERSION;
export const PUBLIC_PREVIEW_TOOL_ALLOWLIST = PUBLIC_TOOL_ALLOWLIST;
export const PUBLIC_PREVIEW_SOURCE_TOOL_COUNT = PUBLIC_SOURCE_TOOL_COUNT;

export const HOUSEHOLD_SERVER_VERSION = "0.1.50-private-construction";
export const HOUSEHOLD_SURFACE_VERSION = "p4-private-construction-v50";
export const HOUSEHOLD_TOOL_ALLOWLIST = Object.freeze([
  "codex.command_exec",
  "codex.project_context",
  "codex.account_preflight",
  "codex.fs_read",
  "codex.process",
  "codex.process_receipt",
  "codex.catalog",
  "codex.skill_read",
  "codex.read_many",
  "codex.precise_edit",
  "codex.browser_status",
  "codex.browser_confirmation_policy",
  "codex.browser_tabs",
  "codex.browser_read",
  "codex.browser_screenshot",
  "codex.browser_prepare_close_tab",
  "codex.browser_close_tab",
  "codex.browser_prepare_open_tab",
  "codex.browser_open_tab",
  "codex.browser_scroll",
  "codex.browser_keypress",
  "codex.browser_prepare_navigate",
  "codex.browser_navigate",
  "codex.browser_prepare_click",
  "codex.browser_click",
  "codex.browser_prepare_download",
  "codex.browser_download",
  "codex.browser_prepare_upload",
  "codex.browser_upload",
  "codex.browser_prepare_fill",
  "codex.browser_fill",
  "codex.call_profile",
  "codex.model_list",
  "codex.agent_start",
  "codex.agent_card_render",
  "codex.agent_card_state",
  "codex.agent_show",
  "codex.agent_steer",
  "codex.agent_send",
  "codex.agent_decline",
  "codex.agent_commit",
  "codex.agent_portable_commit",
  "codex.agent_portable_decline",
  "codex.agent_approve",
  "codex.agent_reject",
  "codex.agent_cancel",
]);
export const HOUSEHOLD_SOURCE_TOOL_COUNT = HOUSEHOLD_TOOL_ALLOWLIST.length;

// Historical/private-construction exports are compatibility aliases, not the canonical product vocabulary.
export const PRIVATE_CONSTRUCTION_SERVER_VERSION = HOUSEHOLD_SERVER_VERSION;
export const PRIVATE_CONSTRUCTION_SURFACE_VERSION = HOUSEHOLD_SURFACE_VERSION;
export const PRIVATE_CONSTRUCTION_TOOL_ALLOWLIST = HOUSEHOLD_TOOL_ALLOWLIST;
export const PRIVATE_CONSTRUCTION_SOURCE_TOOL_COUNT = HOUSEHOLD_SOURCE_TOOL_COUNT;
