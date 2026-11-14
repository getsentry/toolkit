export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `T` with every property that may hold `undefined` made optional instead,
 * so the result fits types that model "unset" as an absent key
 * (`exactOptionalPropertyTypes`).
 */
export type OmitUndefined<T extends object> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<
    T[K],
    undefined
  >;
};

/**
 * Copies `value` without the keys whose value is `undefined`.
 *
 * Use it where a caller forwards optional values (for example MCP tool
 * params) to an API that treats an absent key as "unset" and does not accept
 * an explicit `undefined`.
 */
export function omitUndefined<T extends object>(value: T): OmitUndefined<T> {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      result[key] = entry;
    }
  }
  // Every key left holds a defined value, which is what OmitUndefined<T>
  // describes; TypeScript cannot follow that through Object.entries.
  return result as OmitUndefined<T>;
}
