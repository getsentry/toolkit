import { z } from "zod";
import type { FrameInterface, ThreadEntrySchema } from "../../api-client";

type Frame = z.infer<typeof FrameInterface>;
type Thread = z.infer<typeof ThreadEntrySchema>;
type Stacktrace = {
  frames: Frame[];
  framesOmitted?: unknown[] | null;
};

/** Lines kept on each side of an in-app frame's line, as the markdown frame view shows. */
const IN_APP_CONTEXT_LINES = 3;

/**
 * One stack frame. Shared by `get_issue_details` and `get_event_stacktrace` so
 * both tools describe frames the same way.
 */
export const structuredFrameSchema = z.object({
  filename: z.string().nullable(),
  absPath: z.string().nullable(),
  module: z.string().nullable(),
  package: z.string().nullable(),
  function: z.string().nullable(),
  lineNo: z.number().nullable(),
  colNo: z.number().nullable(),
  inApp: z.boolean().nullable(),
  contextLine: z.string().nullable().describe("The source line at lineNo."),
  preContext: z
    .array(z.string())
    .nullable()
    .describe("Up to 3 source lines before lineNo, for in-app frames only."),
  postContext: z
    .array(z.string())
    .nullable()
    .describe("Up to 3 source lines after lineNo, for in-app frames only."),
  vars: z
    .record(z.string(), z.unknown())
    .nullable()
    .describe("Local variables, recorded for in-app frames only."),
});

export const structuredStacktraceSchema = z.object({
  frames: z
    .array(structuredFrameSchema)
    .describe("Oldest call first; the frame that raised is last."),
  framesOmitted: z.number().nullable(),
});

export const structuredThreadSummarySchema = z.object({
  id: z.union([z.number(), z.string()]).nullable(),
  name: z.string().nullable(),
  state: z.string().nullable(),
  crashed: z.boolean(),
  current: z.boolean(),
  frameCount: z.number(),
});

export const structuredThreadSchema = structuredThreadSummarySchema.extend({
  stacktrace: structuredStacktraceSchema.nullable(),
});

export type StructuredFrame = z.output<typeof structuredFrameSchema>;
export type StructuredStacktrace = z.output<typeof structuredStacktraceSchema>;
export type StructuredThreadSummary = z.output<
  typeof structuredThreadSummarySchema
>;
export type StructuredThread = z.output<typeof structuredThreadSchema>;

/** A string worth returning: empty and whitespace-only strings carry nothing. */
export function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

type FrameContext = Pick<
  StructuredFrame,
  "contextLine" | "preContext" | "postContext"
>;

/** Splits Sentry's `[lineNo, line]` context around the frame's own line, as the event protocol does. */
function mapContext(frame: Frame): FrameContext {
  const lineNo = frame.lineNo;
  const context = lineNo == null ? [] : (frame.context ?? []);
  const contextLine =
    context.find(([contextLineNo]) => contextLineNo === lineNo)?.[1] ?? null;
  if (frame.inApp !== true || lineNo == null) {
    return { contextLine, preContext: null, postContext: null };
  }
  const linesWithin = (from: number, to: number) => {
    const lines = context
      .filter(([contextLineNo]) => contextLineNo >= from && contextLineNo <= to)
      .map(([, line]) => line);
    return lines.length > 0 ? lines : null;
  };
  return {
    contextLine,
    preContext: linesWithin(lineNo - IN_APP_CONTEXT_LINES, lineNo - 1),
    postContext: linesWithin(lineNo + 1, lineNo + IN_APP_CONTEXT_LINES),
  };
}

/** Maps one upstream frame field by field; raw addresses, symbols and source links stay out. */
export function mapStructuredFrame(frame: Frame): StructuredFrame {
  const vars =
    frame.inApp === true && frame.vars && Object.keys(frame.vars).length > 0
      ? { ...frame.vars }
      : null;
  return {
    filename: nonEmptyString(frame.filename),
    absPath: nonEmptyString(frame.absPath),
    module: nonEmptyString(frame.module),
    package: nonEmptyString(frame.package),
    function: nonEmptyString(frame.function),
    lineNo: finiteNumber(frame.lineNo),
    colNo: finiteNumber(frame.colNo),
    inApp: typeof frame.inApp === "boolean" ? frame.inApp : null,
    ...mapContext(frame),
    vars,
  };
}

/** Sentry records omitted frames as a `[start, end]` index pair. */
export function countFramesOmitted(
  framesOmitted: unknown[] | null | undefined,
): number | null {
  const [first, last] = framesOmitted ?? [];
  if (
    typeof first === "number" &&
    typeof last === "number" &&
    Number.isFinite(first) &&
    Number.isFinite(last)
  ) {
    return Math.max(0, last - first);
  }
  return null;
}

export function mapStructuredStacktrace(
  stacktrace: Stacktrace | null | undefined,
): StructuredStacktrace | null {
  if (!stacktrace?.frames?.length) {
    return null;
  }
  return {
    frames: stacktrace.frames.map(mapStructuredFrame),
    framesOmitted: countFramesOmitted(stacktrace.framesOmitted),
  };
}

export function mapStructuredThreadSummary(
  thread: Thread,
): StructuredThreadSummary {
  return {
    id: thread.id ?? null,
    name: nonEmptyString(thread.name),
    state: nonEmptyString(thread.state),
    crashed: thread.crashed === true,
    current: thread.current === true,
    frameCount: thread.stacktrace?.frames?.length ?? 0,
  };
}

export function mapStructuredThread(thread: Thread): StructuredThread {
  return {
    ...mapStructuredThreadSummary(thread),
    stacktrace: mapStructuredStacktrace(thread.stacktrace),
  };
}
