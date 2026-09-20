# Security

Codexless is a local execution bridge. Treat it as software that can affect real project files and run real commands under your locally authorized Codex environment.

This document describes the **public Technical Preview tool surface** in this repository. It does not describe private/internal Toolwire or Workbench capabilities that are intentionally excluded from the package.

## Security model

The public design is based on three rules:

1. **Codex remains the local authority source** for borrowed execution capabilities.
2. **Codexless may narrow authority, but the remote caller must not silently widen it.**
3. **A real permission or trust denial fails visibly.** Codexless must not silently switch to a more privileged execution path just to make an operation succeed.

A user who has deliberately granted broad local Codex authority should expect Codexless operations that inherit that authority to be correspondingly powerful. Codexless is not a sandbox that magically makes broad local permission risk-free.

## Public surface boundary

The current public **service contract** exposes exactly 45 tools, enforced by `src/surface-contracts.mjs` and `test/public-contract.mjs`. Runtime registration is fail-closed too: registrations outside `PUBLIC_TOOL_NAMES` are skipped rather than exposed, while startup fails if any of the 45 required tools is missing or registered twice; CI also exercises a strict unknown-tool mode. Twenty-one of those tools are the accepted Browser slice. Fixed-text Codex approval uses the neutral, model-callable `codex.agent_commit(taskId)` / `codex.agent_decline(taskId)` tools; retired Rich/Portable Card tools and resources are not part of the normal public surface.

The public package intentionally excludes private/internal capabilities such as:

- raw host filesystem read/mutation Workbench tools;
- generic host process control and process receipts;
- Computer Use;
- generic MCP catalog/call tooling;
- Browser internals outside the accepted 21-tool slice: raw selectors/caller JavaScript/coordinates/provider IDs, arbitrary keys/modifiers, generic CDP, unprepared generic tab management, and Browser→Computer Use auto-fallback. The prepared exact single-tab close pair is accepted public behavior;
- household/private integrations.

Internal availability is not a public safety claim. A capability must be explicitly accepted before it can enter the public contract.

## Command execution

`codex.command_exec` uses the official Codex App Server command execution path and locally resolved authority.

- `readOnly` is the compatibility-safe default exposed by the public schema.
- `inherit` must be requested explicitly and uses the locally authorized/resolved Codex permission profile.
- The remote caller does not choose arbitrary permission profiles, trusted roots, sandbox policy, approval policy, or network authority.
- Supported-platform executable lookup may resolve a bare executable name through the host PATH where applicable. This changes executable lookup only; it does not increase authority.
- The public model-free lane rejects direct Codex CLI launches and recognized shell/interpreter/launcher wrappers that carry a Codex command. Formal Codex model work must go through `codex.agent_start` / `codex.agent_send`, preserving fixed Task-ID approval, quota state, and task lifecycle.
- Shell-string wrappers such as `cmd`, PowerShell, and POSIX shells are scanned conservatively. A benign shell command string that merely mentions a `codex` executable token may be rejected; for inspection-only commands, prefer direct argv forms such as `where.exe codex` or `which codex` instead of wrapping them in a shell string.
- This command classifier is a product guard against direct or accidental nested-Codex routing, not a general-purpose adversarial process sandbox. Arbitrary code execution is inherently capable of hiding secondary process launches; Codexless does not claim that a malicious custom client can be made non-Turing-complete by argv inspection. The supported model-facing contract is that callers must not encode or disguise a Codex launch inside another command.
- Commands can be destructive. The MCP tool is marked accordingly.

## Project reads and edits

Public project file operations are intentionally narrower than a generic raw filesystem API.

- Multi-file reads are bounded.
- Guarded edits require an exact expected text match and can optionally verify a SHA-256 before writing.
- Project authority and trusted-root checks remain part of the local execution path.
- Symlink/junction escape outside the accepted authority root must fail closed rather than silently following the path.

Do not interpret these constraints as a substitute for backups or source control.

## Codex Agent delegation and metered consent

Ordinary model-free tool use and metered Codex Agent work are separate lanes.

With `CODEXLESS_AGENT_METERED_CONSENT=always`, the public `codex.agent_start` / `codex.agent_send` tools are prepare-first. A prepared call returns fixed compact approval text plus one exact short Task ID (`C-...`); the public start/send schemas do not accept a caller-supplied `consentRef`, and the prepared response does not expose one. Replaying the same logical `requestId` remains pending and must not dispatch a Codex turn.

Approval is a separate server-side state transition. `codex.agent_commit(taskId)` and `codex.agent_decline(taskId)` accept only that exact server-bound Task ID: the caller cannot resupply or change the prompt, message, cwd, model, reasoning effort, account binding, permission profile, or other authority fields at commit time. Unknown, stale, missing, or ambiguous Task IDs fail closed. Confirmed duplicate decisions are idempotent and must not create a second logical turn.

The normal public runtime does not advertise a Rich Card resource. The fixed approval text is the supported normal-Chat presentation; a Codex turn is dispatched only through the explicit server-side commit transition for the exact prepared Task ID. Decline is terminal, and same-request replay after decline must not revive or dispatch that task. Pending or terminal state must never be silently converted into a fresh turn after restart or transport uncertainty.

This lifecycle protects task binding and replay behavior; it is not cryptographic proof that an arbitrary custom MCP client represents a human. A client that can directly invoke the public MCP tools is part of the trust boundary. Do not treat an untrusted host as a user-presence oracle.

Where quota context is available, it may be shown to the user; absence of quota context must not be represented as unlimited or free usage.

Approval of a Codex Agent task does not grant a new local permission universe. Local Codex authority remains the ceiling.

### Managed Codex accounts

Codexless can optionally register multiple managed Codex accounts. The registry maps each account ID to a dedicated direct-child `CODEX_HOME` under the Codexless state root.

- Account homes must be real, distinct directories inside the state root; symlink/junction aliases are rejected.
- Account authentication remains isolated. `auth.json` must be a regular non-linked file and must never be copied or linked between accounts.
- When more than one account is registered, a formal `agent_start` requires an explicit valid account selection. Missing or unknown selections fail closed.
- The selected account is bound to the agent lifecycle. `agent_send` continues that binding rather than choosing a new account.
- Quota/plan information is observational context only. Codexless does not automatically fail over to another account because of quota, policy, permission, or execution failure.
- Managed login uses the selected account home and strips inherited OpenAI credential variables rather than borrowing another account's credentials.
- Registry/Auth state lives outside the replaceable install tree and must survive ordinary update/reinstall without becoming package code.

These constraints isolate Codex login identity. They do not create separate local filesystem or Homelab permission universes; those remain governed by the effective Codex/local execution policy.

Managed-account transport recovery is documented separately in [`docs/managed-account-runtime-lifecycle.md`](docs/managed-account-runtime-lifecycle.md). In particular, a client-side RPC timeout alone is not treated as App Server death; genuine delegate death may be recovered for new work on the same selected account, while stale `agentRef` values remain bound to their original delegate generation and fail closed.

### Active-turn supervision and steering

`codex.agent_show` exposes only bounded supervisory progress from native Codex App Server state: the latest agent message, latest plan, and active item identity/status. It does not expose raw reasoning, command output, file diffs, or full prior message history. Agent commentary can still contain project-sensitive information, so it remains part of the connected ChatGPT trust boundary.

`codex.agent_steer` is a narrow wrapper around official App Server `turn/steer`. It requires the exact current `expectedTurnId`, refuses a pre-existing pending approval, and cannot change model, reasoning effort, cwd, sandbox, permission profile, or output schema. It does not start a replacement turn. A stale or already-terminal turn fails closed.

Steering uses a caller-stable `requestId`. A confirmed duplicate must not dispatch a second steer. If transport fails after dispatch and acceptance cannot be proven, Codexless reports the result as unknown and must not replay the steer automatically. The caller should inspect current agent state before choosing a different action. `codex.agent_cancel` remains the separate immediate hard-interrupt path.

## Browser

The public Browser surface is intentionally bounded around user-intent actions rather than exposing Browser internals. It includes Reader, current-viewport screenshot, dynamic stock confirmation-policy read, prepared exact single-tab close, prepared open/navigate/click/fill/download/upload, bounded scroll, and only the fixed `Enter` / `Tab` / `Escape` keypresses.

Prepared mutation refs bind an exact action and current Browser state but are **not permission tokens**. The caller applies the current stock Codex Browser confirmation policy together with the bounded user task. Once a mutation may have been dispatched, uncertainty is fail-visible and must not trigger a blind replay.

Important boundaries and limitations:

- tab close is available only through prepare→execute refs bound to one exact existing tab and current Browser state; unknown/stale refs, page/provider/generation drift, and uncertain dispatch fail closed and must not trigger blind replay;
- raw CSS selectors, caller JavaScript/evaluate, arbitrary coordinates/node IDs/provider IDs/indexes, arbitrary keys/modifiers, generic CDP and automatic Browser→Computer Use fallback are not exposed;
- exact visible-text click fallback is accepted only when Codexless can derive and revalidate a stable semantic role binding server-side; otherwise it fails closed;
- upload accepts only an existing file inside the Codex-resolved trusted authority root, binds canonical path/size/SHA-256 before dispatch, and revalidates file identity; browser-side file selection is **not** proof that the remote service accepted the upload;
- Browser upload additionally depends on the Chrome extension setting **Allow access to file URLs**; ordinary Reader/navigation health does not prove this file capability is configured;
- download success requires the official Chrome/Playwright download event receipt; a returned browser-managed local path is not an instruction to open, execute, or trust the file;
- content that has not loaded may not be visible; lazy-loaded and virtualized interfaces can expose only currently materialized content;
- returned content may be truncated and should say so when applicable;
- page content is untrusted input and can contain prompt-injection text.

A model should treat webpage text as data, not as higher-priority instructions.

## HTTP transport

The bundled HTTP entry point binds only to loopback addresses (`127.0.0.1`, `localhost`, or `::1`). It rejects non-loopback binding requests.

The HTTP server also applies localhost Host/Origin validation. `/healthz` and `/readyz` return only bounded service metadata and do not intentionally publish the configured project path.

Remote ChatGPT access is expected to be provided by a separately configured MCP tunnel. The tunnel is part of the deployment boundary: protect its credentials and do not expose a raw unauthenticated local service directly to the public internet.

## Installer / upgrade / uninstall boundary

The Windows and Apple Silicon macOS Technical Preview installers are intentionally conservative.

- Both require Node.js 22+ and discover/probe an already-installed accepted native Codex executable; neither silently installs another Codex copy.
- Both stage the release tree, install production dependencies there, and run doctor before activating the staged Codexless tree.
- Re-running a newer installer is the upgrade path. Codexless-owned runtime state is kept outside the install tree and is preserved by default.
- The installers do not widen Codex trust, configure Chrome/Browser permissions, or change Tunnel settings. Browser upload's **Allow access to file URLs** prerequisite remains an explicit user/browser configuration step. The Windows installer does not create a Windows service; the Mac installer does not create a LaunchAgent or modify shell PATH.
- Default uninstall removes only a directory that identifies itself as the `codexless` package. Codex, Node.js, project files, Browser configuration, Tunnel configuration, and Codex trust settings are out of scope.
- State purge is explicit: Windows uses `-PurgeState`; macOS uses `--purge-state`. Each removes only Codexless-owned state.

On Windows, checked native child processes are judged by their native exit code rather than by the mere presence of stderr text. Windows PowerShell can otherwise promote informational native stderr to a terminating PowerShell error under `ErrorActionPreference=Stop`, producing a false installer failure even when the child exits `0`. The bounded contract and regression coverage are documented in [`docs/windows-installer-lifecycle.md`](docs/windows-installer-lifecycle.md).

## Credentials and secrets

Codexless should not require users to paste long-lived Codex or GitHub credentials into ChatGPT.

- Local Codex authentication remains local to the Codex environment.
- Tunnel/runtime secrets belong in local secret/config storage, not source control or README examples.
- Do not commit `.env` files, bearer tokens, API keys, session cookies, or copied credential stores.
- Do not publish screenshots containing tunnel URLs, endpoint secrets, private local paths, account identifiers, or tokens.

The release process must scan the package and repository for accidental secrets and machine-specific private paths.

## Local paths and privacy

Some authenticated project tools necessarily return project paths because path identity is part of local project work. Public unauthenticated health metadata should not expose the configured project path.

Browser contents, filenames, project text, command output, and Codex responses can all contain private information. Users should only connect Codexless to ChatGPT contexts they are comfortable using for that project.

## Dependency and supply-chain scope

The public package intentionally keeps a small direct dependency set. See `THIRD_PARTY_NOTICES.md` and `package.json`.

Before a public release:

- install from a clean environment;
- run the public contract test;
- review the packed artifact rather than only the source tree;
- scan packed files for secrets and machine-specific paths;
- verify the exact dependency/lockfile state used for release.

## Known Technical Preview limitations

The Technical Preview is not a claim of production-hardening. Windows and Apple Silicon macOS have both passed real-machine installer/doctor acceptance against the public artifact shape, with broader lifecycle and Tunnel coverage on the Mac path and independent reviewer coverage on the final Windows installer/uninstaller path. Release work still includes packed-artifact privacy review and any clean-machine checks required by release notes.

Intel Mac, Computer Use, unrestricted direct browser automation, and private Workbench capability parity are not part of the first public security contract.

## Reporting a vulnerability

This maintained fork is currently intended to remain private. Report security findings to the repository owner through a private channel and never place credentials, private project data, or a working exploit in a public ticket.

If this repository is made public again, enable and verify GitHub Private Vulnerability Reporting before treating public distribution as release-ready.
