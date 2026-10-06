/**
 * Promise Utilities
 *
 * Helpers for concurrent async operations with early-exit behavior.
 */

/**
 * Run async predicate checks in parallel, resolve as soon as any returns true.
 *
 * Unlike Promise.race(), waits for a truthy result, not just the first settlement.
 * Unlike Promise.any(), doesn't require rejection for falsy values.
 *
 * Errors in predicates are treated as `false` - the function continues checking
 * other items rather than rejecting.
 *
 * @param items - Items to check
 * @param predicate - Async function returning boolean for each item
 * @returns True if any predicate returns true, false if all return false or error
 *
 * @example
 * // Check if any file exists
 * const exists = await anyTrue(filenames, (f) => Bun.file(f).exists());
 *
 * @example
 * // Check if any API endpoint responds
 * const reachable = await anyTrue(endpoints, async (url) => {
 *   const res = await fetch(url).catch(() => null);
 *   return res?.ok ?? false;
 * });
 */
export function anyTrue<T>(
  items: readonly T[],
  predicate: (item: T) => Promise<boolean>
): Promise<boolean> {
  if (items.length === 0) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    let pending = items.length;
    let resolved = false;

    const onComplete = (result: boolean) => {
      if (resolved) {
        return;
      }
      if (result) {
        resolved = true;
        resolve(true);
      } else {
        pending -= 1;
        if (pending === 0) {
          resolve(false);
        }
      }
    };

    for (const item of items) {
      predicate(item)
        .then(onComplete)
        .catch(() => onComplete(false));
    }
  });
}
