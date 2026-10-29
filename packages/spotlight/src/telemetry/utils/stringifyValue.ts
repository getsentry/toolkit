/** Preserve scalar text and serialize structured wire values without default object coercion. */
export function stringifyValue(value: unknown): string {
  if (typeof value !== "object" || value === null) return String(value);
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
