/** Browser-safe event classification shared by the Local tail and viewer. */

/**
 * Read SDK message text: a plain string, or a `logentry` / `message` object
 * with `formatted` or `message`. Empty strings count as no text.
 */
export function readMessageText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value || undefined;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  const { formatted, message } = value as {
    formatted?: unknown;
    message?: unknown;
  };
  if (typeof formatted === "string" && formatted) {
    return formatted;
  }
  if (typeof message === "string" && message) {
    return message;
  }
}

/**
 * Whether an event is an exception or a message, so the tail and the viewer
 * label it the same way. Returns undefined when it carries neither.
 *
 * An exception needs a typed thrown value: the last of `exception.values`,
 * which SDKs order oldest to newest. JavaScript SDKs attach a synthetic,
 * untyped exception to `captureMessage` to carry its stack, so an untyped
 * exception with message text is still a message.
 */
export function classifyEvent(
  event: Record<string, unknown>,
): "exception" | "message" | undefined {
  const exception = event.exception as
    | { values?: { type?: unknown; value?: unknown }[] }
    | undefined;
  const values = Array.isArray(exception?.values) ? exception.values : [];
  const last = values.at(-1);
  if (typeof last?.type === "string" && last.type) {
    return "exception";
  }
  const hasText =
    readMessageText(event.logentry) !== undefined ||
    readMessageText(event.message) !== undefined ||
    (last?.value !== undefined && last.value !== "");
  if (hasText) {
    return "message";
  }
  return values.length ? "exception" : undefined;
}
