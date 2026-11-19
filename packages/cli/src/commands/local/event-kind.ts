/** Browser-safe event classification shared by the Local tail and viewer. */

import { exceptionMessage, exceptionValues } from "./exception-values.js";

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
  return undefined;
}

/** How an event reads: its kind, thrown type, and the text to show for it. */
export type EventDescription = {
  kind: "exception" | "message" | undefined;
  /** The type of the thrown exception, when the SDK names one. */
  errorType: string | undefined;
  text: string | undefined;
};

/** Exception value as display text; null, undefined, and "" have none. */
function valueText(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return;
  }
  // Payload values are parsed JSON, so they always serialize back.
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Describe an event so the tail and the viewer label it the same way.
 *
 * An exception needs a typed thrown value: the last exception value,
 * which SDKs order oldest to newest. JavaScript SDKs attach an untyped
 * exception with `mechanism.synthetic: true` to `captureMessage` to carry its
 * stack, so an untyped exception whose value is a non-empty string is still a
 * message. Other untyped values, such as null or a number, are exceptions.
 */
export function describeEvent(
  event: Record<string, unknown>,
): EventDescription {
  const values = exceptionValues(event["exception"]);
  const last = values.at(-1) as { type?: unknown; value?: unknown } | undefined;
  const errorType =
    typeof last?.type === "string" && last.type ? last.type : undefined;
  const rawText = valueText(last?.value);
  const exceptionText =
    rawText === undefined ? undefined : exceptionMessage(errorType, rawText);
  const messageText =
    readMessageText(event["logentry"]) ?? readMessageText(event["message"]);
  if (errorType) {
    return { kind: "exception", errorType, text: exceptionText ?? messageText };
  }
  const text =
    messageText ??
    (typeof last?.value === "string" ? exceptionText : undefined);
  if (text) {
    return { kind: "message", errorType, text };
  }
  return {
    kind: values.length ? "exception" : undefined,
    errorType,
    text: exceptionText,
  };
}

/**
 * Whether an event is an exception or a message; see {@link describeEvent}.
 * Returns undefined when it carries neither.
 */
export function classifyEvent(
  event: Record<string, unknown>,
): "exception" | "message" | undefined {
  return describeEvent(event).kind;
}
