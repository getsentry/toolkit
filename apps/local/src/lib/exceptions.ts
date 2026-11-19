import {
  exceptionMessage,
  exceptionValueText,
  exceptionValues,
} from "../../../../packages/cli/src/commands/local/exception-values.ts";
import {
  describeEvent,
  type EventDescription,
} from "../../../../packages/cli/src/commands/local/event-kind.ts";
import { stripAnsi } from "../../../../packages/cli/src/lib/formatters/strip-ansi.ts";
import { withoutUndefined } from "./objects.ts";

/** Display fields from untrusted SDK exception payloads; raw JSON stays intact. */
export type ExceptionFrame = {
  function: string;
  filename: string;
  line?: number;
  column?: number;
  source?: string;
  variables?: Record<string, unknown>;
  editorPath?: string;
};

export type EventException = {
  isCause: boolean;
  type?: string;
  value?: string;
  frames: ExceptionFrame[];
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function coordinate(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

/**
 * describeEvent for display. Dev servers colour their console logs and
 * captured messages keep the escapes, so message text drops them here; the
 * payload keeps them.
 */
export function describeEventForDisplay(
  event: Record<string, unknown>,
): EventDescription {
  const described = describeEvent(event);
  return described.kind === "message" && described.text
    ? { ...described, text: stripAnsi(described.text) || undefined }
    : described;
}

/** Title an exception the way the Local tail does. */
export function formatExceptionTitle(exception: EventException): string {
  return exception.type
    ? `${exception.type}: ${exception.value ?? "Unknown error"}`
    : (exception.value ?? "Error: Unknown error");
}

/** SDK values and stack frames arrive oldest first; show the current error first. */
export function getEventExceptions(payload: unknown): EventException[] {
  const event = record(payload);
  const values = exceptionValues(event?.["exception"]);
  return values
    .flatMap((value, index): EventException[] => {
      const exception = record(value);
      if (!exception) return [];
      const raw = exceptionValueText(exception["value"]);
      // The current error reads as describeEvent describes the event, so the
      // detail heading matches the list title and the tail: an explicit event
      // message wins over an untyped value, and a typed error without a value
      // takes the message text.
      const described =
        event && index === values.length - 1
          ? describeEventForDisplay(event)
          : undefined;
      // Elsewhere only a string reads as message text; an untyped number is
      // still an error, which the tail labels `Error`.
      const type = described
        ? described.kind === "exception"
          ? (described.errorType ?? "Error")
          : undefined
        : (text(exception["type"]) ??
          (raw !== undefined && typeof exception["value"] !== "string"
            ? "Error"
            : undefined));
      const message = described
        ? described.text
        : raw && exceptionMessage(type, raw);
      const rawFrames = record(exception["stacktrace"])?.["frames"];
      const frames = Array.isArray(rawFrames)
        ? rawFrames
            .flatMap((raw): ExceptionFrame[] => {
              const frame = record(raw);
              if (!frame) return [];
              // Unlike the tail's frameFile basename, the viewer has room for
              // the full path, which tells same-named files apart.
              const filename =
                text(frame["filename"]) ??
                text(frame["abs_path"]) ??
                text(frame["module"]);
              const name = text(frame["function"]);
              const line = text(frame["context_line"]);
              const before = Array.isArray(frame["pre_context"])
                ? frame["pre_context"].filter(
                    (value): value is string => typeof value === "string",
                  )
                : [];
              const after = Array.isArray(frame["post_context"])
                ? frame["post_context"].filter(
                    (value): value is string => typeof value === "string",
                  )
                : [];
              const source =
                before.length || after.length
                  ? [...before, line ?? "", ...after].join("\n")
                  : line;
              if (!filename && !name && !source) return [];
              return [
                withoutUndefined({
                  function: name ?? "<anonymous>",
                  filename: filename ?? "Unknown source",
                  line: coordinate(frame["lineno"]),
                  column: coordinate(frame["colno"]),
                  source,
                  ...(record(frame["vars"])
                    ? { variables: record(frame["vars"]) }
                    : {}),
                  ...(text(frame["abs_path"]) && frame["abs_path"] !== filename
                    ? { editorPath: text(frame["abs_path"]) }
                    : {}),
                }),
              ];
            })
            .reverse()
        : [];
      return type || message || frames.length
        ? [
            withoutUndefined({
              type,
              value: message,
              frames,
              isCause: record(exception["mechanism"])?.["source"] === "cause",
            }),
          ]
        : [];
    })
    .reverse();
}
