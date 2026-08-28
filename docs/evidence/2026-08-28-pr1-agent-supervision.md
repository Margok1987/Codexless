# PR1 Agent Supervision — Engineering Evidence — 2026-08-28

Status: **historical engineering evidence, not accepted product truth**

This file records the bounded Codexless Agent Supervision work performed on 2026-08-28 so a later engineering session can resume from a proven point without relying on chat history.

## Scope and intended PR1

The original bounded target was:

1. `codex.agent_show` exposes useful bounded progress.
2. `codex.agent_steer` can influence the currently running turn.
3. stale, duplicate, uncertain, or conflicting steering fails closed or reconciles deterministically.
4. no reasoning, command output, secrets, or unrestricted transcript leaks through progress.
5. Task Card usage represents current-turn usage rather than cumulative thread usage, with thread totals/quota represented separately.
6. real end-to-end acceptance uses `gpt-5.6-luna` with reasoning effort `xhigh`.
7. the production Windows launcher/tunnel path remains restart/update/reboot stable.

PR2 PATH/App Execution Alias work is intentionally separate.

## Proven local steering baseline

Local source worktree:

`D:\codex\dennis\homelab-engineering-workspace\runtime\codexless-upstream`

Branch used during development:

`feat/agent-steering-progress`

Last explicitly selected rollback/baseline commit from the morning steering work:

`ed36dcbc16afa3cdb06aaba2b1b97c899e551435`

Important: at the time this evidence file was written, this commit was **local-only** and was not present on `Margok1987/Codexless` GitHub. Therefore this document records the SHA as evidence only; it does not claim that GitHub currently contains that code.

Engineering decision after later failures:

> Do not continue development on the uncommitted post-`ed36dcbc` changes as if they were accepted. Preserve them as evidence, then restore the source checkout to `ed36dcbc...` and re-qualify from there.

## Windows runtime / tunnel evidence

The final Windows launcher design before the PR1 investigation used:

- VBS launcher: `C:\Users\Dennis\AppData\Local\Codexless-Launcher\Codexless starten.vbs`
- Startup shortcut: `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Codexless starten.lnk`
- Desktop shortcut also existed for manual launch.
- Product runtime HTTP port: `127.0.0.1:7690`
- parallel test port `17692` was expected absent after finalization.
- Secure MCP Tunnel profile: `codexless`
- pinned Codex binary version: `0.147.0`
- Homelab model policy: `gpt-5.6-luna`, reasoning `xhigh`.

Previously qualified launcher/reboot/update evidence included:

- exactly one Codexless runtime and one tunnel after restart.
- health reported `ok=true` and service tool count `43`.
- GUI update did not tear down the launcher/tunnel path.
- reboot/login restored the full chain.
- model-visible connector surface was observed as `40` tools.

These observations are historical evidence and should be re-read from runtime before new acceptance claims.

## Real Agent Supervision E2E findings

### Steering/progress path

A real formal agent run showed that transport-level steering could be accepted while the turn was active. Work then focused on proving native persisted correlation rather than treating transport acceptance alone as proof of semantic observation.

The intended correlation rule became:

- `turn/steer` response proves request/transport acceptance only.
- persisted same-turn `userMessage.clientId` plus exact steering text provides native evidence that the steer was observed/delivered.
- transport-unknown must not be replayed with a new logical request id; reconcile from native history first.
- stale turn ids fail closed.
- duplicate request ids are idempotent.

No later work should weaken this distinction between transport acceptance and observed same-turn delivery.

### MCP elicitation bug discovered during real E2E

A real running agent reached an App Server request with method:

`mcpServer/elicitation/request`

The then-current rejection path treated it as unsupported, so the agent had to be cancelled safely. Source investigation of Codex `rust-v0.147.0` indicated native elicitation response actions `accept`, `decline`, and `cancel`.

A local post-baseline fix was developed and targeted tests passed, but this fix was not yet accepted as part of a proven final PR1 baseline when rollback was requested. Treat it as evidence to reconsider independently after restoring `ed36dcbc...`.

### Token semantics bug discovered during real E2E

A minimal agent run showed current-turn usage of approximately `33,746` tokens while cumulative `threadTotal` was approximately `219,112`. The Portable/Task Card rendered the cumulative figure as generic usage.

This demonstrated a real semantic bug: current-turn usage must be derived and displayed separately from cumulative thread totals.

A post-baseline fix was developed using turn-start baseline versus final cumulative total, but again should be re-qualified independently after rollback.

## Rich Card / commit capability investigation

Several post-baseline changes attempted to secure Task Card approval by binding a hidden server-generated `commitToken` to the exact prepared task and requiring that token for the app-only `codex.agent_commit` path.

Design intent:

- `consentRef` / prepared-record identifiers are lookup identifiers, not approval evidence.
- Rich Card approval should require a host/component-only capability that is not exposed through ordinary model-visible structured content.
- Portable exact-task approval remains a separate server-bound path.

Local tests were extended to verify:

- capability present in server result metadata.
- capability absent from structured/user-visible text.
- missing token rejected.
- wrong token rejected.
- correct token dispatches only the exact prepared task.

The card resource URI was also bumped from v13 to v14 to force cache invalidation.

### Critical real-world result: v14 FAILED

Despite local targeted tests passing and despite deploying the v14 resource build, a completely fresh ChatGPT session with working Codexless connector reproduced:

`Input validation error: Invalid arguments for tool codex.agent_commit: commitToken: Invalid input: expected string, received undefined`

This occurred after:

- new build was installed.
- a fresh MCP/ChatGPT session was used.
- connector discovery worked.
- `codex.project_context` worked in the fresh session.
- a new task/card was prepared.

Therefore the earlier theory that the failure was merely a stale v13 ChatGPT card cache is **disproven**.

Accepted evidence now is only:

- the server schema expects `commitToken`.
- the real ChatGPT Rich Card path calls `codex.agent_commit` without a usable token.
- local harness tests did not reproduce the real host/component data path.

Do **not** build further fixes on the v14 implementation without first reducing the problem to a minimal real-host test and re-deriving the correct MCP Apps metadata/bridge behavior.

## Post-baseline source changes that must not be treated as accepted

At one point the working tree contained 12 tracked modifications related to the expanded PR1 investigation:

- `README.md`
- `README.zh-CN.md`
- `SECURITY.md`
- `config/release-manifest.json`
- `src/agent-card-ui.mjs`
- `src/agent-resource.mjs`
- `src/agent-tools.mjs`
- `src/codex-agent-executor.mjs`
- `src/upstream-compatibility-fingerprint.mjs`
- `test/agent-consent-card.mjs`
- `test/agent-steering-progress.mjs`
- `test/upstream-compatibility-fingerprint.mjs`

These changes included steering reconciliation, token semantics, elicitation handling, consent/card capability changes, documentation, tests, and release identity updates.

Because the real v14 card path failed, this entire uncommitted set must be regarded as **experimental evidence**, not a foundation for further engineering.

Other broad-audit and installer changes had already been split out and preserved separately under ignored local `_work/scope-hold/` patches. They were not intended for PR1.

## Builds observed during the investigation

Historical local/deployed build ids included:

- `825f3ee7610ca6d370e0595a6f5aa28cb5b88003667840c4f6f44063cbcb0e41`
- later v14 candidate: `8cfbc707e0329bc5a432e6734cbd36a968567e2a0f98bf18de83972b07757c0c`

The v14 candidate was deployed to the local Codexless install. A deployment transcript initially observed the tunnel too early (`TUNNEL_COUNT=0`), but a subsequent read-only check showed one runtime, one tunnel, 43 service tools, build `8cfbc707...`, and no listener on 17692.

The v14 Rich Card still failed in a fresh ChatGPT session. Therefore deployment success is not Agent Supervision acceptance.

## Connector/session behavior observed

During repeated MCP reconnect/reload testing, some existing ChatGPT conversations entered a state where connector discovery still returned tools but subsequent direct tool calls failed with `Resource not found` or the connector became disabled for that conversation.

A truly fresh ChatGPT session later showed:

- 40 visible Codexless tools.
- `codex.project_context` functional.
- Codex 0.147.0.
- skill routing status `ok`.
- model alignment `gpt-5.6-luna`.
- no agent had been started during the precheck.

This fresh-session PASS separated transient ChatGPT connector-session binding issues from the later reproducible Rich Card v14 failure.

## UniFi evidence from earlier real-system testing

System access through the engineering environment was proven separately with read-only native API evidence.

One native read showed:

- site `Default`.
- 7 devices.
- all 7 online.
- U7 Lite at `10.10.10.67`.
- firmware `8.7.11`.

A formal agent later reported a conflicting U7 firmware value (`7.5.10`). Native re-read confirmed `8.7.11`.

Engineering rule retained from this result:

> deterministic native readbacks outrank agent prose; Codex/Luna output is evidence, not automatically engineering truth.

No UniFi mutation was part of this PR1 work.

## Separate deferred findings

The following are real or plausible findings but explicitly **not part of the rollback baseline / immediate PR1 continuation**:

- PowerShell 5.1 native stderr behavior in installer wrappers.
- broader public HTTP/contract/diagnostic cleanup.
- PATH/App Execution Alias work (PR2).
- Codex Desktop 0.150 compatibility work.
- general Browser feature work.
- managed-runtime redesign.
- dependency upgrades.

Do not pull these into the next Agent Supervision session unless they independently block the exact bounded acceptance path.

## Required rollback before further Agent Supervision engineering

Next session must first establish the source/runtime baseline rather than continuing from v14.

Desired source state:

1. preserve all current post-`ed36dcbc` modifications as patch/evidence outside the active tracked source.
2. reset active source checkout to exactly:
   `ed36dcbc16afa3cdb06aaba2b1b97c899e551435`
3. verify clean `git status`.
4. verify that `codex.agent_steer` exists in that baseline.
5. run only the steering tests that actually exist at that commit.
6. inspect exactly what functionality the commit contains before deciding what must be reimplemented.

Only after source baseline qualification should the productive local Codexless installation be rolled back in a second bounded step. Do not mix source rollback and production-runtime rollback into an opaque operation.

## Next engineering question

After rollback, the immediate question is deliberately narrow:

> What did `ed36dcbc...` actually implement and prove for `agent_show` + `agent_steer`, and what is the smallest additional change required to complete the original Agent Supervision acceptance without inheriting unproven Card/token/elicitation redesigns?

Do not assume the post-baseline fixes are needed. Re-derive each gap from a real deterministic test.

## Acceptance discipline for the resumed session

Preferred sequence:

1. inspect baseline source.
2. identify one open requirement.
3. perform the smallest deterministic test.
4. decide based on evidence.
5. make one bounded change only if required.
6. run targeted regression tests.
7. deploy only after source qualification.
8. perform real ChatGPT E2E.
9. native readback beats agent prose.
10. only then commit/push/open PR.

No further architecture expansion until the original PR1 goal is either accepted or explicitly re-scoped.