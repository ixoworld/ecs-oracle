import { Logger } from '@nestjs/common';
import type { BaseCheckpointSaver } from '@langchain/langgraph';

/**
 * Wraps a LangGraph checkpoint saver and logs the wall-clock duration of
 * every async call (`put`, `putWrites`, `getTuple`, etc.). Anything taking
 * longer than `warnAboveMs` gets a WARN line so we can prove (or disprove)
 * that synchronous SQLite writes against the network-backed PVC are what's
 * stalling the event loop on testnet.
 *
 * `better-sqlite3` is synchronous: a single `put` call can block the thread
 * for tens-to-hundreds of milliseconds when each `INSERT` / `fsync` round-
 * trips to remote storage. Locally on SSD it's microseconds, which is why
 * the same code feels instant on Mac and laggy in the cluster. The wrapper
 * makes that delta visible without touching the package source.
 */
export function timedCheckpointer<T extends BaseCheckpointSaver>(
  saver: T,
  label: string,
  warnAboveMs = 100,
): T {
  const logger = new Logger(`CheckpointerTiming:${label}`);
  return new Proxy(saver, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver) as unknown;
      if (typeof orig !== 'function') return orig;
      const method = orig as (...args: unknown[]) => unknown;
      return function (this: unknown, ...args: unknown[]) {
        const start = Date.now();
        let result: unknown;
        try {
          result = method.apply(target, args);
        } catch (err) {
          const elapsed = Date.now() - start;
          logger.error(
            `${String(prop)} threw after ${elapsed}ms: ${err instanceof Error ? err.message : String(err)}`,
          );
          throw err;
        }
        if (result instanceof Promise) {
          return result
            .then((value) => {
              const elapsed = Date.now() - start;
              if (elapsed >= warnAboveMs) {
                logger.warn(`${String(prop)} took ${elapsed}ms`);
              }
              return value;
            })
            .catch((err: unknown) => {
              const elapsed = Date.now() - start;
              logger.error(
                `${String(prop)} rejected after ${elapsed}ms: ${err instanceof Error ? err.message : String(err)}`,
              );
              throw err;
            });
        }
        const elapsed = Date.now() - start;
        if (elapsed >= warnAboveMs) {
          logger.warn(`${String(prop)} (sync) took ${elapsed}ms`);
        }
        return result;
      };
    },
  });
}
