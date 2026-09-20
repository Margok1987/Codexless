# Windows installer lifecycle

This document defines the Windows installer rule for native child-process success and failure in Codexless.

The executable contract remains the current installer source and regression tests in this repository.

## Why this rule exists

Windows PowerShell can convert text written by a native process to stderr into a PowerShell error record. With `$ErrorActionPreference = "Stop"`, that error record can terminate the surrounding PowerShell operation even when the native process itself completed successfully with exit code `0`.

This matters for package managers and other command-line tools because informational notices, warnings, progress messages, or deprecation text may legitimately be written to stderr without indicating command failure.

A concrete failure mode occurred during a Codexless update:

```text
npm ci
  -> dependencies installed successfully
  -> npm emits an update notice on stderr
  -> native exit code is 0
  -> Windows PowerShell promotes stderr to a terminating error
  -> installer reports DEPENDENCY_INSTALL_FAILED
  -> update rolls back even though npm succeeded
```

The npm notice was not a dependency conflict and did not require updating npm.

## Native command success authority

For checked native child processes launched by the Windows installer:

```text
native exit code 0     -> command success
native exit code != 0  -> command failure
stderr text alone      -> not command failure
```

The installer therefore temporarily uses `ErrorActionPreference = "Continue"` while the checked native process is executing. It captures or forwards process output as required, records `$LASTEXITCODE`, evaluates the native exit code, and then restores the previous PowerShell error preference.

This scope is intentionally narrow. It prevents PowerShell from reclassifying native stderr as a terminating installer failure while preserving normal fail-closed behavior for actual nonzero native exits.

## JSON installer mode

When the installer runs in JSON mode, native stdout and stderr may be captured together for diagnostic detail.

A successful native process may therefore contribute stderr text to the captured diagnostic stream without causing failure.

If the native exit code is nonzero, the installer includes captured output in the raised command failure so the real native diagnostic remains available to the caller.

## What this does not change

This rule does not:

- ignore nonzero native exit codes;
- suppress or reinterpret dependency-manager diagnostics;
- treat all PowerShell errors as harmless;
- change Node.js or npm version requirements;
- automatically update npm;
- bypass installer lifecycle, doctor, state-compatibility, backup, rollback, or activation checks;
- weaken Codexless permission, trust, account-isolation, or state-preservation rules.

Only the classification of native-process stderr is changed: stderr is diagnostic output, while the native exit code is the success/failure authority for the checked child process.

## Rollback behavior

If a later installer phase genuinely fails, the ordinary installer transaction still applies.

Depending on the lifecycle stage, Codexless preserves or restores the prior install, account state, bootstrap state, ownership markers, and retained backup according to the existing installer contract.

A harmless stderr notice must not trigger that rollback path. A real command failure still can.

## Regression coverage

The Windows installer lifecycle test uses a synthetic `npm.cmd` fixture that deliberately emits:

```text
stdout: normal package-manager output
stderr: npm-notice-style informational output
exit:   0
```

Fresh install and update must both continue successfully through that condition.

The same lifecycle suite also verifies managed-account state preservation across install/update boundaries and exercises rollback and failure paths.

Relevant source and test:

- `scripts/install.ps1`
- `test/installer-lifecycle-windows.mjs`

## Review rule

Future Windows installer code that launches checked native programs should preserve this distinction:

> PowerShell stream classification is not a substitute for the native process exit code.

If a child tool has its own documented success contract that differs from ordinary process exit semantics, that exception must be explicit, narrow, and covered by a regression test.
