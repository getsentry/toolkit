/** Browser-safe reads of event exceptions, shared by the Local tail, daemon and viewer. */

/**
 * The exceptions an event's `exception` carries, oldest to newest. Most SDKs
 * send `{ values: [...] }`; sentry-go sends the list itself.
 */
export function exceptionValues(exception: unknown): unknown[] {
  if (Array.isArray(exception)) {
    return exception;
  }
  const values =
    exception !== null && typeof exception === "object"
      ? (exception as { values?: unknown }).values
      : undefined;
  return Array.isArray(values) ? values : [];
}

/**
 * An exception value as display text: a non-empty string, or a number as SDKs
 * sometimes send; anything else has no text, so callers show `Unknown error`.
 */
export function exceptionValueText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value || undefined;
  }
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : undefined;
}

/**
 * An exception's message without a trailing ` (<type>)` on its first line.
 * Ruby's `detailed_message`, which sentry-ruby sends, appends the class name
 * that the type already shows to the first line, before any code snippet.
 */
export function exceptionMessage(
  type: string | undefined,
  value: string,
): string {
  const lineEnd = value.indexOf("\n");
  const first = lineEnd === -1 ? value : value.slice(0, lineEnd);
  const suffix = ` (${type})`;
  return type && first.length > suffix.length && first.endsWith(suffix)
    ? first.slice(0, -suffix.length) + value.slice(first.length)
    : value;
}

/**
 * The file a stack frame names: `filename`, else the basename of `abs_path`,
 * which is all sentry-go sends. A URL drops its query and hash.
 */
export function frameFile(frame: {
  filename?: unknown;
  abs_path?: unknown;
}): string | undefined {
  if (typeof frame.filename === "string" && frame.filename) {
    return frame.filename;
  }
  if (typeof frame.abs_path !== "string") {
    return;
  }
  const path = /^[a-z][a-z\d+.-]*:\/\//i.test(frame.abs_path)
    ? frame.abs_path.replace(/[?#].*$/, "")
    : frame.abs_path;
  return path.split(/[\\/]/).at(-1) || undefined;
}
