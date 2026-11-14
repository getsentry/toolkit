/**
 * Object Key Utilities
 *
 * With `exactOptionalPropertyTypes`, an optional property (`key?: T`) does
 * not accept an explicit `undefined`. Dependency types, such as the `query`
 * objects of `@sentry/api` or Sentry SDK event fields, declare optional keys
 * this way, while callers forward values that may be `undefined`. These
 * helpers drop those keys for APIs that treat an absent key as "not set".
 */

/** Keys of `T` whose value can be `undefined`. */
type UndefinedKeys<T> = {
  [K in keyof T]-?: undefined extends T[K] ? K : never;
}[keyof T];

/**
 * `T` with every key that can hold `undefined` made optional, without
 * `undefined` in its value type.
 */
export type OmitUndefined<T> = Omit<T, UndefinedKeys<T>> & {
  [K in UndefinedKeys<T>]?: Exclude<T[K], undefined>;
};

/**
 * Copy `value` without the keys whose value is `undefined`.
 *
 * @param value - Object whose `undefined` values mean "not set"
 * @returns A shallow copy without those keys
 */
export function omitUndefined<T extends object>(value: T): OmitUndefined<T> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      out[key] = entry;
    }
  }
  // The loop copied exactly the keys that OmitUndefined<T> keeps.
  return out as OmitUndefined<T>;
}
