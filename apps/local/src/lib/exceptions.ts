import {
  exceptionMessage,
  exceptionValueText,
  exceptionValues,
} from "../../../../packages/cli/src/commands/local/exception-values.ts";
import { describeEvent } from "../../../../packages/cli/src/commands/local/event-kind.ts";
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
      // Only a string reads as message text, as in describeEvent; an untyped
      // number is still an error, which the tail labels `Error`.
      const type =
        text(exception["type"]) ??
        (raw !== undefined && typeof exception["value"] !== "string"
          ? "Error"
          : undefined);
      // A typed current error without a value takes describeEvent's text (the
      // event message), so the detail heading matches the list title.
      const message =
        (raw && exceptionMessage(type, raw)) ??
        (type && index === values.length - 1 && event
          ? describeEvent(event).text
          : undefined);
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
