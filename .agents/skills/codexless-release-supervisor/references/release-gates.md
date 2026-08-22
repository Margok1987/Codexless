# Codexless release gates

Use this reference only for release/hotfix preparation or publication. The canonical household repository is the policy and implementation authority; public candidate/official repositories are downstream release sinks.

## 1. Canonical preflight and freeze

Record:

- target version and release type;
- canonical branch, full HEAD, origin state, and working tree;
- current Acceptance suite/registry version;
- current latest GitHub release;
- actual installed Codexless version/build on supported dogfood platforms when a release is already published;
- active runtime/Tunnel and Host/front-door identity relevant to the installed line;
- Windows and Apple Silicon macOS execution paths;
- unrelated working-tree changes and active writers.

Before final candidate gating, canonical must be clean and frozen. Do not run concurrent writers against it.

**Current-version diagnosis gate:** if a reported installed symptom comes from a version older than the latest published release, update that line to the exact current release and align runtime/Tunnel + Host/front-door state before opening a new current-version source bug.

## 2. Canonical source and anti-omission gates

Run from canonical:

```text
git diff --check
npm run test:all
npm run test:acceptance:auto
npm run test:public-export
```

`test:all` recursively auto-discovers `.mjs` files under `test/`, takes manual/helper exclusions from the same Acceptance registry, and treats any discovered required Node Test `SKIP` as fail-closed rather than PASS. It remains the broader release-wide source gate. Run it through the maintained prepared harness/environment required by older Codex/MCP fixture tests; a missing harness or a required test that cannot execute is BLOCKED, not a reason to silently narrow the list. `test:acceptance:auto` separately proves the current Acceptance Markdown IDs and registry are synchronized, recursively classifies the test inventory, and executes each registered deterministic Acceptance/governance file under a bounded per-file timeout.

`AUTOMATED_GREEN` is a source/preflight result only. It must never be reported as full Acceptance GREEN while required Host/live evidence is still pending.

A new Acceptance ID that is not registered is FAIL. A Host/live requirement omitted from the external gate registry is FAIL. A referenced evidence test that does not exist is FAIL.

## R1 deterministic canonical→public projection gate

Before candidate materialization, run the canonical exporter against a Git repository that contains the exact public migration-base commit pinned by `config/public-export-policy.json`:

```text
npm run release:public-export -- --base-repo <repo-containing-pinned-public-base> --dry-run
```

For migration comparison only, `--compare <existing-public-working-tree>` may be added. Comparison is read-only and never makes that working tree an authority. To materialize a reviewable projection, replace `--dry-run` with `--output _work/<fresh-projection-dir>`; output outside canonical `_work/` is rejected. An optional receipt must be one direct file under canonical `_work/`.

R1 authority is explicit and fail-closed:

- `config/public-export-policy.json` owns the exact target allowlist and source mapping; an undeclared, duplicate, traversal, or otherwise unsafe target is rejected rather than copied;
- the immutable public migration seed is read only as Git blobs from its exact pinned public commit; dirty/untracked files in a public working tree are never export input;
- shared/current Browser/compatibility/Skill files named by the policy are read as Git blobs from the exact canonical source commit;
- `.agents/skills/codexless-release-supervisor/*` is projected from canonical `maintainer/skills/codexless-release-supervisor/*` and may not acquire an independent public authority;
- public-only source lives under canonical `release/public-overlay/`. Existing historical public files may use exact-base patches only when the patch binds the base commit SHA-256 and expected output SHA-256 and every replacement matches exactly once; newly added public-only files live as complete overlay sources;
- public `package.json` is generated from the immutable public base plus declarative canonical/overlay rules. Dirty public `package.json` bytes are not an input;
- `config/release-manifest.json` is intentionally excluded because it is a later candidate/release generated identity file, not a hand-maintained overlay.

The R1 receipt binds the canonical source commit, pinned public base commit, exporter version, policy/exporter source hashes, exact file list, per-file SHA-256/size/source authority, and deterministic content-tree SHA-256. A successful R1 receipt may truthfully report `fullDeterministicExporter=true`, but it does not prove candidate, native fresh-install, or publication acceptance. Any exporter/policy/overlay/canonical source change invalidates the old R1 receipt.

## 3. Candidate materialization and R0 provenance gate

Materialize the public candidate through the current controlled promotion process, then run from canonical:

```text
npm run release:candidate-gate -- --candidate <public-candidate-root>
```

The R0 gate requires:

- canonical working tree is clean;
- candidate `config/release-manifest.json` has a full `sourceRevision` exactly equal to canonical HEAD;
- candidate `.agents/skills/codexless-release-supervisor` exactly matches the canonical maintainer Skill source;
- Browser public-export parity passes through the maintained canonical parity test;
- a deterministic candidate-content snapshot hash/file count plus the explicit top-level local-noise exclusions is written only as one direct regular file under canonical `_work/`; `_work` itself must be a real directory (not a symlink/junction), an existing receipt target must be a single-link regular file (not a symlink/junction, hard link, or directory), and a receipt path outside `_work/` or inside the candidate root is rejected before candidate reads/writes.

The R0 receipt deliberately reports:

```text
fullDeterministicExporter: false
```

This remains an important historical boundary. R0 binds the candidate to a frozen canonical commit plus a deterministic snapshot of candidate content under the declared local-noise exclusions and targeted parity evidence. It does **not** prove that every public candidate file was deterministically generated from canonical. The separate R1 exporter now proves that projection property for its own receipt; R1 must not be back-claimed by, or used to rewrite the meaning of, an R0 candidate receipt.

Any candidate edit after the receipt invalidates the candidate snapshot and requires a fresh gate.

## 4. Downstream release identity and source gates

Once the public candidate has passed the canonical R0 provenance gate, run the maintained candidate release mechanics. These may still physically live in the downstream public candidate during R0, but they do not become a second policy authority.

Normally include:

```text
npm run release:manifest
npm run release:preflight
npm test
npm pack --dry-run --json
```

The manifest must retain the same canonical `sourceRevision` proven by the R0 gate. If regenerating the manifest changes the candidate tree/build identity, rerun the canonical candidate gate and all contaminated downstream checks.

Check that the release tree contains no temporary caches, `_work`, `node_modules`, platform analysis caches, `nul`, generated platform archives, or other stray files.

## 5. Frozen public source identity

Codexless does not publish or maintain platform installer archives. The release unit is the exact public source tree/tag plus its release identity metadata.

Record:

- canonical sourceRevision;
- candidate snapshot SHA;
- version;
- buildId;
- release-manifest identity.

Any source/candidate/install-script change requires contamination analysis, new identity as applicable, and fresh downstream native-install acceptance.

## 6. Windows x64 native fresh-install acceptance

On a native Windows x64 host, start from a clean checkout/export of the exact frozen public candidate/tag with no pre-existing `node_modules`. Use isolated fresh `HOME`/`USERPROFILE`, Codexless state root, and install directory. Run the documented public installer from repository root:

```text
.\\bin\\codexless-install.cmd
```

Required GREEN evidence:

- installer exits 0 and returns the expected version/build identity;
- installed doctor reports core OK and preserves any explicit onboarding/PENDING state without silent fallback;
- installed public stdio exposes exactly the current public contract;
- Browser status/open/read/close succeeds against `https://example.com/` and leaves no residual test tab;
- no Household/Main Road/backend substitution and no patching user configuration merely to make the test pass.

Do not hard-code a release-specific public tool count; derive the expected public contract from the frozen candidate/install itself.

**Managed Runtime Preview addendum:** Managed Preview remains a Windows x64 hard gate, not a Codexless-wide Windows-only claim. The canonical Acceptance registry owns the separate Managed runtime/login/persistence/uninstall/front-door evidence. Source tests or household runtime evidence cannot substitute for the required native receipts.

## 7. Apple Silicon macOS native fresh-install acceptance

On a native Apple Silicon macOS host, start from the same exact frozen public candidate/tag with no pre-existing `node_modules`, using isolated fresh user/state/install roots. Run the documented installer from repository root:

```text
./bin/codexless-install.sh
```

Require the same installed doctor, public stdio, Browser status/open/read/close/no-residual evidence as Windows. Do not assume Windows and macOS Codex/ChatGPT Browser layouts are identical. Use current observed trusted runtime facts rather than weakening path/authority checks. Managed Preview being Windows-gated does **not** remove or weaken this Existing-runtime macOS release gate, and Mac Managed must not be reported GREEN until a later suite deliberately adds and proves it.

## 8. Candidate → official sync and Git safety

After the candidate and both native fresh-install gates are fully green, synchronize the exact candidate into the official Git repository while preserving `.git` and excluding temporary/build-only directories. Verify recursive relative-path + SHA equivalence.

Before commit/push:

```text
git fetch origin
git status --short
git log HEAD..origin/main
git log origin/main..HEAD
```

Rules:

- never force-push;
- preserve valid remote hotfix/release history;
- if necessary, attach the already-validated exact release tree to current `origin/main`, then prove tree identity did not drift;
- stop on semantic conflict rather than guessing.

## 9. GitHub prerelease publication

Only after Windows and macOS native fresh-install gates are GREEN and the user has authorized publication:

- commit the exact official release tree;
- push `main`;
- create the target prerelease/tag;
- publish source/tag release metadata and the release manifest if the release workflow uses it.

Do not generate or upload Windows ZIP / macOS tar.gz installer packages or SHA256SUMS for platform packages.

Release notes must describe verified facts only.

## 10. Post-publication verification

From official, verify Git/source identity directly:

```text
git fetch origin --tags
git status --short
git rev-parse HEAD
git rev-parse origin/main
git rev-list -n 1 <target-tag>
```

Required publication state: target version/tag is latest/current, the tag and `origin/main` resolve to the intended published source, the public release manifest (if present) retains the frozen `sourceRevision`/buildId, `HEAD == origin/main`, and working tree is clean.

This proves publication metadata only. Do not report `RELEASE GREEN` or `INSTALL_COMPLETE` yet.

## 11. Installed closeout and full Acceptance

The release-owning mainline keeps ownership after publication. In the same closeout cycle:

1. record actual installed version/build on Windows and Apple Silicon macOS before reinstall/alignment;
2. install or reinstall from the exact published public source/tag using the documented platform installer and verify resulting identity;
3. restart the release-owned Codexless runtime/Tunnel path while preserving intended user state/Profile/Tunnel identity;
4. refresh/reconnect Host/App as needed and prove the active front door exposes the intended contract;
5. run the complete current Acceptance suite. For the machine runner, provide exact external evidence receipts:

```text
npm run test:acceptance -- --subject-version <version> --subject-build-id <buildId> --evidence <host-evidence.json>
```

The evidence file must declare a `subject` matching that exact version/buildId. Every PASS entry must name structured `environment.host`, `environment.platform`, and `environment.frontDoor`, plus an ISO `observedAt` and concrete evidence receipt. Any failed item, subject mismatch, malformed environment binding, or missing required external item is non-GREEN;
6. run a genuinely fresh standalone front-door/Temporary Chat smoke, not Household/Main Road;
7. capture every required Host/UI Golden/visual canonical.

Only after all seven are GREEN may the release owner report `RELEASE GREEN` and affected lines as `INSTALL_COMPLETE`.

## 12. Released-baseline gate before next-version work

Do not use behavior from a stale installed release to drive a new source fix. First make the latest published baseline GREEN through installed closeout. Next-version source changes come from canonical and flow through a new candidate/provenance/acceptance chain. Installed-tree hot edits remain diagnostic evidence only.

## Contamination map

- documentation/release-notes-only change → recheck affected policy/metadata parity;
- Release Supervisor/acceptance-registry change → rerun canonical anti-omission gates + candidate supervisor parity;
- candidate file change → new candidate snapshot/provenance receipt + affected downstream gates;
- source/test/package/manifest-input change → resume from canonical source gates and candidate provenance;
- Browser runtime compatibility change → canonical tests + candidate parity + Windows/macOS native fresh-install Browser acceptance;
- installer change → lifecycle/install tests + fresh native installs + downstream closeout;
- Agent/card/reasoning change → focused deterministic suite + required Host Golden; if it changes the public candidate, repeat affected native fresh-install acceptance.

## Gate receipt

For each gate, report only concrete state:

```text
Gate: <name>
Status: GREEN | RED | BLOCKED | AUTOMATED_GREEN
Canonical: <full commit if applicable>
CandidateSnapshot: <sha256 if applicable>
Version: <version>
BuildId: <buildId if known>
Evidence: <minimal concrete receipts>
Next: <single next gate or blocker action>
```
