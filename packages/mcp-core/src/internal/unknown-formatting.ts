/**
 * Formats an arbitrary value for display without producing `[object Object]`.
 *
 * Nullish values render as `unknown`, primitives render directly, and
 * everything else is JSON encoded.
 */
export function formatUnknown(value: unknown): string {
  if (value === null || value === undefined) {
    return "unknown";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}
