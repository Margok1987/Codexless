---
name: codexless-browser-repair
description: Diagnose and temporarily repair Codexless Browser compatibility after a Codex, Chrome Skill, or Browser runtime update when Codexless Browser stopped working. Use for current-version Codexless Browser compatibility drift, not ordinary website bugs, general Browser operation, Codexless install/update work, or long-term compatibility architecture.
---

# Codexless Browser Repair

Use this Skill only for a current-machine Codexless **Browser compatibility** failure after upstream Codex / Chrome Skill / Browser runtime changed. The normal product path is automatic compatibility through the Codexless scanner, fingerprint, and known adapters. This Skill is the last-resort self-rescue path for an unknown Browser drift.

## Core contract

- Keep the user in the Chat entry point. Chat diagnoses and coordinates; Codex is called only when an unknown code-level Browser drift genuinely needs a repair worker.
- Start model-free. A Codex version/build change by itself is not a repair reason.
- Do not turn this Skill into a permanent compatibility framework, updater, daemon, or authority layer.
- Do not modify upstream Codex bundles, Chrome extension files, `.codex/plugins` cache, or private Browser service internals.
- Never widen Codex trust, permission profile, roots, network authority, or approval policy to make a repair pass.
- Never use private `turnEnded`, forged rollout JSONL, fake Codex turn completion, or another unproven private cleanup path to manufacture Browser handback/release.
- Ordinary website failures, login problems, selector/page-layout bugs, and normal Browser operation are not this Skill.

## 1. Identify the target before touching it

Determine whether the task targets:

- the Codexless household/source checkout, where a formal source fix is appropriate; or
- an installed Codexless release, where only a **temporary local Browser repair** is allowed.

Do not guess an install root from memory. Resolve it from the actual Codexless launcher/doctor/runtime context available on the machine. Do not treat the upstream Codex/Chrome plugin directory as the Codexless repair target.

## 2. Run model-free compatibility evidence first

From a Codexless tree that contains the compatibility reporter, run it in a **host-state context** that can read the current user Codex config, Skills, and plugin cache:

```text
npm run compatibility:report
```

Do not treat a sandboxed collector as upstream evidence. If the report says `collectionEnvironment.status=INCOMPLETE`, `compatibilityDecisionUsable=false`, or `fingerprint.relevantCapabilityHash=null`, re-run it from the correct host-state lane before classifying drift. In particular, `config_overrides_unreadable` or a missing current Chrome Skill from an incomplete collection environment is not by itself evidence that upstream compatibility broke.

Also use the current model-free Browser status/catalog surfaces when available. If Browser status explicitly reports `BROWSER_RUNTIME_COMPAT_CHANGED_RESTART_REQUIRED`, restart/rebind the **Codexless-owned runtime** and retry before escalating. That is normal compatibility recovery, not a code repair. A Codex Desktop restart is a last-resort user recovery only if a fresh App Server still cannot discover the current Skill/Browser state after Codexless has refreshed its own runtime.

Collect only evidence relevant to compatibility, such as:

- resolved Codex executable/version and platform/arch provenance;
- Chrome Skill / Browser bundle build pairing;
- `node_repl` server, `js` tool, and normalized input schema shape;
- Browser client lifecycle members and the existing normalized lifecycle classification;
- relevant capability fingerprint/hash and structured warnings/unavailable reasons.

Do not inspect or mutate a real user tab merely to diagnose an upstream compatibility drift.

## 3. Classify before calling Codex

### A. Compatible or already known

If relevant capabilities are unchanged or an existing adapter already handles the observed shape, do not call Codex. Use the ordinary Codexless path or report the actual non-compatibility problem.

### B. Unknown relevant Browser drift, capability may still exist

Only this class proceeds to a formal Codex code-repair task.

### C. Capability missing or safety semantics unproven

Stop and fail visibly. Examples include no public release/unclaim/finalize path, a required Browser capability being absent, or approval/ownership/replay semantics that cannot be proven equivalent. Do not replace an upstream capability gap with a private workaround.

## 4. Escalate to Codex only for class B

Before local reverse engineering, inspect the current official `openai/codex` source/protocol when it can explain the observed shape: App Server protocol/schema, relevant Browser/feature configuration, and the source or release diff around the resolved Codex build. Treat upstream source as an explanation aid, not runtime truth; confirm it against the user's actual fingerprint. Only inspect local Desktop/Browser bundle internals when the public source/protocol does not explain the seam.

When Codex is needed, keep the task narrow. Give it:

- the compatibility report/evidence;
- the exact Codexless target root;
- the current Codex/Chrome Skill/Browser bundle evidence;
- any relevant official upstream source/protocol evidence already found;
- the specific Browser compatibility adapter/source and directly relevant tests or verifier paths;
- this Skill as the repair contract.

The Codex task is to find the smallest current-version compatibility patch. Typical repairable drift includes path/member renames, schema-shape changes, or a changed Browser facade where equivalent upstream capability still exists.

Do not ask Codex to redesign Codexless, update unrelated features, alter authority, or solve a missing upstream capability.

## 5. Temporary installed-release patch protocol

For an installed release, a code patch is allowed only when diagnosis proves class B and the user has asked to repair Browser. Before changing files:

1. Record the installed Codexless release identity and current relevant upstream fingerprint.
2. Select only the Codexless Browser-compatibility files required by the repair.
3. Record each target file's relative path and pre-repair SHA-256.
4. Create a recoverable backup outside the release tree under a user-local Codexless repair state directory.

Recommended receipt location:

```text
~/.config/codexless/browser-repairs/<repair-id>/
  repair.json
  backup/...
```

The receipt may contain base release identity, relevant fingerprint/hash, changed relative paths, pre/post hashes, validation results, and repair status. Do not store tab URLs/titles, account identity, prompts/transcripts, tokens/quota, credentials, or secrets.

After the patch:

- record post-repair hashes;
- do not change or fake the package version;
- state clearly that this installation has a temporary local Browser repair;
- keep the backup until an official Codexless update/reinstall supersedes the repair.

A later official Codexless install is authoritative and may replace the temporary repair. Never replay a stale repair over a newer official install.

## 6. Validate without manufacturing risk

For a source checkout, run the current relevant compatibility/Browser regressions. At minimum use the compatibility reporter and the Browser-related targeted tests supplied by that checkout.

For an installed release that does not ship test fixtures, validate with the packaged model-free compatibility reporter and current read-only Browser status first. Only use a disposable/low-risk Browser smoke if static/model-free evidence is insufficient, and follow the current Browser confirmation policy. Do not use a real user tab as a disposable fixture.

A repair is not accepted merely because code loads. Verify that:

- the previously unknown relevant shape is now recognized without lying about unsupported capability;
- `node_repl/js` and bundle pairing remain fail-closed where required;
- existing-tab release/handback is never reported proven unless the current public upstream shape actually proves it;
- no unrelated authority or product surface changed.

## 7. Report and stop

Return a compact repair receipt to Chat/user:

- what drift was found;
- whether Codex was needed;
- files changed and backup/rollback location;
- validation performed and results;
- what remains unverified;
- whether the result is a temporary local repair or a formal source fix;
- what upstream fact would make the repair unnecessary.

Then stop. Do not continue into long-term adapter/state-machine design, release publishing, push, or unrelated cleanup unless separately authorized.
