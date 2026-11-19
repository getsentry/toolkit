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
 * An exception's message without a trailing ` (<type>)`. Ruby's
 * `detailed_message`, which sentry-ruby sends, appends the class name that the
 * type already shows.
 */
export function exceptionMessage(
  type: string | undefined,
  value: string,
): string {
  const suffix = ` (${type})`;
  return type && value.length > suffix.length && value.endsWith(suffix)
    ? value.slice(0, -suffix.length)
    : value;
}

/**
 * The file a stack frame names: `filename`, else the basename of `abs_path`,
 * which is all sentry-go sends.
 */
export function frameFile(frame: {
  filename?: unknown;
  abs_path?: unknown;
}): string | undefined {
  if (typeof frame.filename === "string" && frame.filename) {
    return frame.filename;
  }
  return typeof frame.abs_path === "string"
    ? frame.abs_path.split(/[\\/]/).at(-1) || undefined
    : undefined;
}
