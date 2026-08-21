---
name: codexless-release-supervisor
description: Prepare, validate, and publish Codexless preview/hotfix releases from the canonical household source, including acceptance anti-omission gates, candidate provenance/parity, manifest/build identity, exact-artifact Windows/macOS acceptance, safe Git integration, GitHub prerelease upload, and post-release verification. Use for Codexless release work; do not trigger for ordinary feature development.
---

# Codexless Release Supervisor

Run Codexless releases as a fail-closed state machine. The **canonical Codexless source repository is the only editable implementation truth**. Public candidate/official repositories are downstream release sinks and must not independently evolve release policy or implementation.

Prefer maintained scripts and observable receipts over memory or hand-written test lists. Keep the current release scope fixed; log non-blocking follow-ups instead of expanding the release.

## Start

1. Resolve the canonical repository and read its Git state, target version, and current acceptance suite version.
2. Read [references/release-gates.md](references/release-gates.md) before final release/hotfix gating.
3. Freeze the canonical commit before deterministic public projection or candidate provenance is claimed.
4. Materialize the public projection through the canonical R1 exporter before candidate work. `config/public-export-policy.json` is the fail-closed file authority; `release/public-overlay/` is the only canonical public-only overlay source. The exporter reads canonical bytes from the exact Git source commit and reads the immutable public migration seed only from its pinned Git commit, never from a dirty public working tree.
5. Treat the R1 projection receipt and the older R0 candidate receipt as different evidence. R1 may truthfully report `fullDeterministicExporter=true`; the R0 candidate gate remains historical candidate-provenance evidence with `fullDeterministicExporter=false` and must not be rewritten or back-claimed.
6. Build or materialize a release candidate only after the R1 projection is reviewed. Candidate/install/artifact/publication work is a later gate and is not proven by the exporter.
7. If the user asked only for preparation, stop before `git push`, tag creation, or GitHub Release publication.

## Canonical machine gates

Use the canonical repository's maintained entries:

```text
npm run test:all
npm run test:acceptance:auto
npm run test:public-export
npm run release:public-export -- --base-repo <repo-containing-pinned-public-base> --dry-run
npm run release:candidate-gate -- --candidate <public-candidate-root>
```

- `test:all` recursively auto-discovers `.mjs` regression files and takes manual/helper exclusions from the same Acceptance registry rather than a second list. A discovered required test that reports Node Test `SKIP` is fail-closed, not PASS. It is a separate release-wide source gate and must run through the maintained prepared harness/environment for tests that require Codex/MCP fixtures. If that harness is unavailable or a required release-wide test cannot run, the release is BLOCKED; `test:acceptance:auto` does not substitute for it.
- `test:acceptance:auto` validates the current Acceptance ID registry and runs each registered deterministic AUTO/INTEGRATION/governance evidence file independently with a bounded per-file timeout. `AUTOMATED_GREEN` is **not** full release GREEN because required Host/live evidence is intentionally still outstanding.
- `test:public-export` is the R1 governance regression for deterministic allowlisting, immutable-base reads, exact overlay patches, generated public package rules, provenance semantics, read-only comparison, and `_work/`-only materialization.
- `release:public-export` requires a clean canonical source commit; reads all canonical/direct/overlay inputs from that exact Git commit; reads the pinned public migration seed by commit blob rather than public working-tree bytes; rejects undeclared/duplicate/unsafe targets; excludes candidate-generated `config/release-manifest.json`; and records the exact file list, per-file SHA-256, content tree SHA-256, exporter/policy hashes, source commit, and base commit. Its R1 receipt may report `fullDeterministicExporter=true`, but explicitly reports candidate/install/exact-artifact/publish evidence as false.
- `release:candidate-gate` remains the R0 downstream candidate gate: it requires a clean canonical HEAD, exact candidate manifest `sourceRevision == canonical HEAD`, exact Release Supervisor parity, Browser public-export parity, and records a deterministic candidate-content snapshot with explicit local-noise exclusions. Its R0 receipt still says `fullDeterministicExporter=false`; do not reinterpret that older receipt as R1 or use R1 to claim candidate acceptance.
- Full `npm run test:acceptance -- --subject-version <version> --subject-build-id <buildId> --evidence <host-evidence.json>` is fail-closed: evidence must match the exact release subject, every PASS must name structured host/platform/front-door + observation time + receipt, and any failed or missing required Host/live item blocks GREEN.

## Invariants

- Any source, test, package, installer, Browser-runtime, Release Supervisor, acceptance-registry, or manifest-input change invalidates the old build identity and affected downstream acceptance evidence.
- Canonical source tests are not release-artifact evidence. Final Windows and Apple Silicon macOS archives must each be installed from the exact frozen artifact and exercised independently.
- Public candidate/official repositories may contain release mechanics needed to package the downstream tree, but those copies are not allowed to become a second policy/source authority. Candidate Release Supervisor content must match this canonical source exactly.
- The release-owning mainline owns the entire closeout through post-publication exact install/update, runtime/Tunnel restart, Host refresh/reconnect, full installed acceptance, fresh front-door invocation, and required Goldens on supported dogfood platforms. Publication is not completion.
- An unfinished release/install/acceptance tail must never be handed to unrelated background/white-shift automation unless the owner explicitly reassigns the release.
- Before treating an installed symptom as a current-version bug, record latest published identity and actual installed product/build, runtime/Tunnel, and Host/front-door identity. Update/align stale installs first.
- Installed-package hot patches are diagnostic evidence only and never become canonical implementation source.
- Household/Main Road success never substitutes for standalone public Codexless evidence.
- Never force-push. Fetch before publishing and preserve valid remote release/hotfix history.
- Do not reuse stale artifacts, stale SHA values, stale provenance receipts, or pre-fix Goldens.
- Do not modify Tunnel identity, user permissions, or unrelated MCP configuration as part of release closure.
- A failed gate stops the pipeline. Repair the blocker, determine its contamination boundary, and rerun every affected downstream gate.

## Execution style

Use maintained scripts first. Gather compact evidence: canonical commit, acceptance suite/registry result, candidate snapshot/provenance receipt, version, buildId, artifact SHA256 values, install/doctor result, Browser Golden result, Git HEAD/origin state, and GitHub release verification.

When a platform-specific failure appears, distinguish product failure from local environment noise with the smallest reproducible check before changing source.

Before external mutation, honor the user's current authorization. A request to prepare a release is not authorization to publish it. A request to publish the prepared release is sufficient to continue unless a new material scope/risk appears.

## Completion

Do not say the release, install, or update is complete until all required gates in the reference are GREEN, the full Acceptance runner has **no failed or skipped required item**, post-publication verification reports the current version as up to date with verified asset/manifest digests, and supported dogfood installs complete the installed closeout.

`RELEASE GREEN`, `INSTALL_COMPLETE`, and `UPDATE_COMPLETE` are forbidden while any required installed/runtime/Tunnel/Host/front-door/Golden gate is failed or skipped.

Return a compact final receipt with:

- canonical commit + candidate provenance/snapshot receipt
- acceptance suite version + AUTO/INTEGRATION/Host result
- version and buildId
- Windows/macOS artifact SHA256
- commit and remote status
- GitHub release/tag status
- post-release check/verify status
- Windows/macOS installed version/build identity
- runtime/Tunnel + Host/front-door acceptance status
- required Goldens
- any deferred non-blocking follow-up, including R1 deterministic-export work if still open
