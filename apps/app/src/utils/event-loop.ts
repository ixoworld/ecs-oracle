/**
 * Cooperative event-loop yields.
 *
 * Node's single-threaded model means any synchronous CPU work blocks the
 * HTTP server (including the kubelet liveness probe). LangGraph builds
 * its agent state, runs middleware, and assembles tool calls all on the
 * main loop — under a probe with `timeoutSeconds: 1, failureThreshold: 3`,
 * a 3+ second sync run risks a SIGKILL.
 *
 * `yieldToEventLoop()` schedules a `setImmediate` continuation, which:
 *   - unblocks the I/O queue (so any pending HTTP request — like the
 *     probe — can be processed)
 *   - reorders us behind already-queued microtasks/timers
 *   - costs <1 ms in normal conditions
 *
 * Use it at coarse boundaries where we KNOW we just did meaningful CPU
 * work and the next chunk is also going to be CPU-heavy. Don't sprinkle
 * it everywhere — every yield is a context switch and a small allocation.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * `yieldToEventLoop` but only if a meaningful amount of time has elapsed
 * since `start` (defaults to 50 ms). For tight loops that may iterate
 * thousands of times — most iterations are too cheap to need a yield;
 * we only want to yield when the cumulative work has actually been long
 * enough to matter for liveness.
 */
export async function yieldIfBusy(
  start: number,
  thresholdMs = 50,
): Promise<number> {
  if (Date.now() - start >= thresholdMs) {
    await yieldToEventLoop();
    return Date.now();
  }
  return start;
}
