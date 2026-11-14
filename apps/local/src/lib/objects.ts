/** Whether `undefined` is one of the specific members of `T`. */
type IncludesUndefined<T> = unknown extends T
  ? false
  : undefined extends T
    ? true
    : false;

/**
 * `T` with each property whose type includes `undefined` made optional and
 * `undefined`-free: the shape {@link withoutUndefined} returns. `unknown`
 * properties, such as raw payloads, stay as they are.
 */
export type WithoutUndefined<T> = {
  [K in keyof T as IncludesUndefined<T[K]> extends true ? never : K]: T[K];
} & {
  [K in keyof T as IncludesUndefined<T[K]> extends true ? K : never]?: Exclude<
    T[K],
    undefined
  >;
};

/**
 * A copy of `value` without its `undefined` properties, so optional fields
 * parsed from a payload are omitted when unset instead of present and
 * `undefined`.
 */
export function withoutUndefined<T extends object>(
  value: T,
): WithoutUndefined<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as WithoutUndefined<T>;
}
