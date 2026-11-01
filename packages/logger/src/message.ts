/** Formats log arguments into a message, the way `console.log` would. */

import { sep } from "node:path";
import { formatWithOptions } from "node:util";

/** Options for formatting log arguments, as consola passed them. */
const INSPECT_OPTIONS = { colors: false, compact: true } as const;

/** An `Error`, or anything else carrying a stack. */
type ErrorLike = { message?: unknown; stack: string; cause?: unknown };

function isErrorLike(value: unknown): value is ErrorLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { stack?: unknown }).stack === "string"
  );
}

/**
 * Render an error as its message, its stack frames, and its causes. Unlike
 * `util.inspect`, this leaves out the error's other properties, which can
 * hold request or response details.
 */
function formatError(error: ErrorLike, depth: number, stack: boolean): string {
  const message =
    typeof error.message === "string"
      ? error.message
      : formatWithOptions(INSPECT_OPTIONS, error);
  const prefix = depth > 0 ? `${"  ".repeat(depth)}[cause]: ` : "";
  let cause = "";
  if (isErrorLike(error.cause)) {
    cause = `${stack ? "\n\n" : " "}${formatError(error.cause, depth + 1, stack)}`;
  } else if (error.cause) {
    cause = `${stack ? `\n\n${"  ".repeat(depth + 1)}` : " "}[cause]: ${formatWithOptions(INSPECT_OPTIONS, error.cause)}`;
  }
  if (!stack) {
    return `${depth > 0 ? "[cause]: " : ""}${message}${cause}`;
  }
  const indent = "  ".repeat(depth + 1);
  const cwd = process.cwd() + sep;
  const frames = error.stack
    .split("\n")
    .slice(message.split("\n").length)
    .map(
      (frame) => indent + frame.trim().replace("file://", "").replace(cwd, ""),
    )
    .join("\n");
  return `${prefix}${message}\n${frames}${cause}`;
}

/**
 * Format log arguments with `util.format` semantics. Errors render as their
 * message and causes, plus their stack frames when `stack` is true.
 */
export function formatMessage(
  args: readonly unknown[],
  { stack }: { stack: boolean },
): string {
  return formatWithOptions(
    INSPECT_OPTIONS,
    ...args.map((arg) => (isErrorLike(arg) ? formatError(arg, 0, stack) : arg)),
  );
}
