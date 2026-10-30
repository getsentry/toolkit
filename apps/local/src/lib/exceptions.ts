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

export function formatExceptionTitle(exception: EventException): string {
  return (
    [exception.type, exception.value].filter(Boolean).join(": ") || "Error"
  );
}

/** SDK values and stack frames arrive oldest first; show the current error first. */
export function getEventExceptions(payload: unknown): EventException[] {
  const values = record(record(payload)?.exception)?.values;
  if (!Array.isArray(values)) return [];
  return values
    .flatMap((value): EventException[] => {
      const exception = record(value);
      if (!exception) return [];
      const type = text(exception.type);
      const message = text(exception.value);
      const rawFrames = record(exception.stacktrace)?.frames;
      const frames = Array.isArray(rawFrames)
        ? rawFrames
            .flatMap((raw): ExceptionFrame[] => {
              const frame = record(raw);
              if (!frame) return [];
              const filename =
                text(frame.filename) ??
                text(frame.abs_path) ??
                text(frame.module);
              const name = text(frame.function);
              const line = text(frame.context_line);
              const before = Array.isArray(frame.pre_context)
                ? frame.pre_context.filter(
                    (value): value is string => typeof value === "string",
                  )
                : [];
              const after = Array.isArray(frame.post_context)
                ? frame.post_context.filter(
                    (value): value is string => typeof value === "string",
                  )
                : [];
              const source =
                before.length || after.length
                  ? [...before, line ?? "", ...after].join("\n")
                  : line;
              if (!filename && !name && !source) return [];
              return [
                {
                  function: name ?? "<anonymous>",
                  filename: filename ?? "Unknown source",
                  line: coordinate(frame.lineno),
                  column: coordinate(frame.colno),
                  source,
                  ...(record(frame.vars)
                    ? { variables: record(frame.vars) }
                    : {}),
                  ...(text(frame.abs_path) && frame.abs_path !== filename
                    ? { editorPath: text(frame.abs_path) }
                    : {}),
                },
              ];
            })
            .reverse()
        : [];
      return type || message || frames.length
        ? [
            {
              type,
              value: message,
              frames,
              isCause: record(exception.mechanism)?.source === "cause",
            },
          ]
        : [];
    })
    .reverse();
}
