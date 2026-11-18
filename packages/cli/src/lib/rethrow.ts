/**
 * Rethrow a value caught earlier, unchanged.
 *
 * Code that records a failure in a callback and throws it once the work
 * settles keeps the caught value as `unknown`. Checking that a value was
 * recorded (`!== undefined`, `!== null`) narrows `unknown` to `{}`, which
 * `typescript/only-throw-error` rejects even though the value is the caught
 * error. Route those deferred rethrows through this function; throw `Error`
 * instances everywhere else.
 */
export function rethrow(error: unknown): never {
  throw error;
}
