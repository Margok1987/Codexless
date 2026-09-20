# Managed account runtime lifecycle

This document defines the Codexless lifecycle contract for long-lived managed Codex App Server runtimes.

It exists to make the runtime-recovery semantics explicit and reviewable independently of the implementation. The executable contract remains the current source and tests in this repository.

## Problem class

Managed Codex accounts use long-lived Codex App Server delegates. A single account delegate can serve model-free account inspection, model catalog reads, authority preparation, formal agent starts, follow-ups, and supervision.

Historically two behaviors combined badly:

1. any client-side RPC timeout caused `CodexAppServerClient` to close the entire persistent App Server process; and
2. if that delegate died while process-local `agentRef` bindings still existed, the account executor refused to create a replacement delegate.

The result was a poisoned account pool:

```text
one RPC exceeds the client timeout
        -> persistent App Server is closed
        -> old agent bindings remain
        -> account runtime cannot be recreated
        -> CODEX_ACCOUNT_RUNTIME_LOST
        -> model_list / agent_start remain unavailable
        -> only a full Codexless HTTP-host restart clears the stale bindings
```

This failure is not a quota-exhaustion contract. Quota or rate-limit state is observational account context; it does not define App Server process liveness.

## Core invariants

### RPC timeout is not process death

A `CodexRpcTimeoutError` means only that Codexless did not receive a response to that request within the configured client deadline.

It does **not** by itself prove that the long-lived Codex App Server process is dead or unusable.

Therefore:

- the individual request fails with `CodexRpcTimeoutError`;
- the App Server process is not closed merely because that request timed out;
- no account fallback or quota routing occurs;
- no timed-out mutation or metered operation is blindly replayed.

Initialization remains different: failure to initialize a newly launched App Server still fails startup closed and drains the owned process.

### Timed-out response IDs are bounded tombstones

A request can time out locally and still complete later in the App Server.

Codexless retains a bounded set of timed-out response IDs. If a late response arrives for one of those IDs:

1. its RPC envelope is still validated;
2. the response is discarded because the caller has already observed a timeout;
3. the late response is not treated as an unknown-ID protocol violation;
4. the App Server remains usable.

The tombstone set is bounded so a long-running host cannot accumulate unbounded timeout state.

Responses with truly unknown IDs remain protocol errors. Timeout handling therefore does not weaken the general fail-closed protocol validation.

### Genuine process death is exposed immediately

`CodexAppServerClient.running` reflects actual child-process liveness, including exit code, signal state, close state, and cleanup failure state.

When the owned child process really exits, the delegate is dead even if asynchronous cleanup has not completed yet.

Protocol corruption, explicit close, real child exit, and cleanup failure remain distinct from a normal RPC timeout.

## Managed-account recovery

Each formal agent binding is tied to both:

- the selected managed account; and
- the exact delegate generation (`delegateEpoch`) that created the agent.

Conceptually:

```text
agentRef -> accountId -> delegateEpoch
```

If that delegate genuinely dies:

- existing `agentRef` values remain bound to the dead generation;
- they are never silently redirected to a replacement App Server;
- calls against those stale agents fail closed with `CODEX_ACCOUNT_RUNTIME_LOST`;
- new work on the **same explicitly selected account** may create a fresh delegate generation.

This is transport recovery, not account failover. Codexless never chooses another managed account because of quota, policy, permission, timeout, process failure, or cleanup failure.

Stale agent bindings from older delegate generations do not consume live-agent capacity for new work.

## Start acceptance and replay safety

A timeout after a request was dispatched creates an acceptance-uncertain state.

For `thread/start`, Codexless preserves the start binding instead of deleting it and allowing the same logical request to dispatch again.

The observable contract is:

```text
thread/start request times out
        -> status = unknown
        -> original clientRequestId remains bound
        -> same requestId returns the same unknown agent binding as a duplicate
        -> no second thread/start is dispatched automatically
```

The same principle applies generally to operations whose acceptance cannot be proven: uncertainty is surfaced; Codexless does not convert transport uncertainty into blind replay.

## Cleanup and quarantine

A dead delegate can be replaced only after its owned cleanup has completed successfully.

If cleanup fails:

- the account is quarantined;
- Codexless does not spawn a replacement delegate over uncertain owned state;
- safety-control behavior remains restricted to the exact still-live delegate generation where applicable;
- the failure remains visible as `CODEX_ACCOUNT_CLEANUP_FAILED`.

Cleanup quarantine is intentionally stronger than ordinary runtime recovery.

## HTTP-host restart

A full Codexless HTTP-host restart is no longer the normal recovery mechanism for a dead managed-account delegate.

The host restart still resets process-local state, so old agent bindings are not assumed usable across an HTTP-host restart. Persistent account registry, account homes, authentication, and policy state remain outside that process-local binding state.

## Regression coverage

The lifecycle is covered by repository tests including:

- isolated RPC timeout does not kill a healthy persistent App Server;
- repeated client-side RPC timeouts do not silently terminate a live process;
- late responses to timed-out requests are safely discarded;
- genuine child exit is visible immediately;
- dead account runtime can be recreated for new work;
- stale agent refs remain fail-closed after recovery;
- replay of an acceptance-unknown start does not dispatch a second start;
- concurrent account recovery creates only one replacement delegate;
- cleanup failure quarantines the account.

Relevant suites:

- `test/codex-app-server-lifecycle.mjs`
- `test/codex-account-security.mjs`

## Non-goals

This lifecycle contract does not add:

- automatic account selection;
- quota-based routing;
- account failover;
- resurrection of old agent handles;
- replay of acceptance-unknown operations;
- bypass of local Codex authority, policy, or approval gates.

The purpose is narrower: keep a healthy long-lived App Server alive through ordinary client-side timeout uncertainty, and recover safely from genuine delegate death without rebinding stale work.
