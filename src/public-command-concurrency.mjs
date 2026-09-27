export function createPublicCommandConcurrencyGate(maxConcurrent) {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 4) {
    throw new Error("maxConcurrent must be an integer between 1 and 4");
  }
  let inFlight = 0;
  return {
    tryAcquire() {
      if (inFlight >= maxConcurrent) return null;
      inFlight += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        inFlight -= 1;
      };
    },
    snapshot() {
      return { inFlight, maxConcurrent };
    },
  };
}

export function createPublicCommandBusyResult({ inFlight, maxConcurrent, surfaceVersion }) {
  const structuredContent = {
    status: "busy",
    errorCode: "BRIDGE_BUSY_PRE_DISPATCH",
    retryable: true,
    retryAfterMs: 500,
    dispatch: "not_started",
    effect: "none",
    inFlight,
    maxConcurrent,
    surfaceVersion,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: false,
  };
}
