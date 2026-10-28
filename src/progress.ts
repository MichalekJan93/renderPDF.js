import type { RenderProgress } from './api-types.js';
import { throwIfAborted } from './diagnostics.js';

/** One export owns its callback error and optional browser scheduling state. */
export function createProgressReporter(
  /** Synchronous application listener, absent when progress was not requested. */
  callback: ((progress: RenderProgress) => void) | undefined,
  /** Optional cooperative cancellation shared with the rendering pipeline. */
  signal?: AbortSignal,
) {
  let callbackFailure: { error: unknown } | undefined;
  let lastYield = 0;
  const report = callback
    ? async (progress: RenderProgress): Promise<void> => {
        throwIfAborted(signal);
        try {
          callback(Object.freeze({ ...progress }));
        } catch (error) {
          callbackFailure = { error };
          throw error;
        }
        throwIfAborted(signal);
        // Task yields let browser status updates and cancellation run without adding timers to other exports.
        if (
          progress.stage !== 'complete' &&
          (progress.completed === 0 ||
            progress.completed === progress.total ||
            performance.now() - lastYield >= 32)
        ) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          lastYield = performance.now();
          throwIfAborted(signal);
        }
      }
    : undefined;
  return {
    report,
    /** Preserve application exceptions across lower-level PDF adapter error wrapping. */
    rethrow(error: unknown): never {
      if (callbackFailure) throw callbackFailure.error;
      throwIfAborted(signal);
      throw error;
    },
  };
}
