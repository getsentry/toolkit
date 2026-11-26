import { z } from "zod";
import type { FrameInterface, ThreadEntrySchema } from "../../api-client";
import { findMostRelevantInAppFrame } from "../../internal/code-location";

type Frame = z.infer<typeof FrameInterface>;
type Thread = z.infer<typeof ThreadEntrySchema>;
type Stacktrace = {
  frames: Frame[];
  framesOmitted?: unknown[] | null | undefined;
};

/** Lines kept on each side of the detail frame's line, as the markdown frame view shows. */
const DETAIL_CONTEXT_LINES = 3;

/** A local variable whose JSON is longer than this is cut to this many characters. */
const MAX_VAR_LENGTH = 200;

/**
 * One stack frame. Shared by `get_issue_details` and `get_event_stacktrace` so
 * both tools describe frames the same way. Fields with no value are left out.
 */
export const structuredFrameSchema = z.object({
  filename: z.string().optional(),
  absPath: z
    .string()
    .optional()
    .describe("Present only when it differs from filename."),
  module: z.string().optional(),
  package: z.string().optional(),
  function: z.string().optional(),
  lineNo: z.number().optional(),
  colNo: z.number().optional(),
  inApp: z.literal(true).optional().describe("Present on application frames."),
  contextLine: z.string().optional().describe("The source line at lineNo."),
  preContext: z
    .array(z.string())
    .optional()
    .describe(
      "Up to 3 source lines before lineNo, on the most relevant frame only.",
    ),
  postContext: z
    .array(z.string())
    .optional()
    .describe(
      "Up to 3 source lines after lineNo, on the most relevant frame only.",
    ),
  vars: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Local variables, on the most relevant frame only. Values longer than 200 characters of JSON are cut to a string.",
    ),
});

export const structuredStacktraceSchema = z.object({
  frames: z
    .array(structuredFrameSchema)
    .describe(
      "Most recent call last. The most relevant frame is the last in-app frame.",
    ),
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

/** Source lines from Sentry's `[lineNo, line]` context between two line numbers. */
function contextLinesWithin(frame: Frame, from: number, to: number) {
  const lines = (frame.context ?? [])
    .filter(([contextLineNo]) => contextLineNo >= from && contextLineNo <= to)
    .map(([, line]) => line);
  return lines.length > 0 ? lines : undefined;
}

/** Copies local variables key by key, cutting values whose JSON is too long. */
function mapVars(
  vars: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (!vars) {
    return undefined;
  }
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(vars)) {
    const json = JSON.stringify(value);
    mapped[key] =
      json.length > MAX_VAR_LENGTH
        ? `${json.slice(0, MAX_VAR_LENGTH)}…`
        : value;
  }
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

/**
 * Maps one upstream frame field by field and writes only the fields that have
 * a value. Raw addresses, symbols and source links stay out. Surrounding
 * context lines and variables go only on the detail frame.
 */
export function mapStructuredFrame(
  frame: Frame,
  { detail = false }: { detail?: boolean } = {},
): StructuredFrame {
  const mapped: StructuredFrame = {};
  const filename = nonEmptyString(frame.filename);
  const absPath = nonEmptyString(frame.absPath);
  const module = nonEmptyString(frame.module);
  const pkg = nonEmptyString(frame.package);
  const fn = nonEmptyString(frame.function);
  const lineNo = finiteNumber(frame.lineNo);
  const colNo = finiteNumber(frame.colNo);
  if (filename) mapped.filename = filename;
  if (absPath && absPath !== filename) mapped.absPath = absPath;
  if (module) mapped.module = module;
  if (pkg) mapped.package = pkg;
  if (fn) mapped.function = fn;
  if (lineNo !== null) mapped.lineNo = lineNo;
  if (colNo !== null) mapped.colNo = colNo;
  if (frame.inApp === true) mapped.inApp = true;
  if (lineNo !== null) {
    const contextLine = frame.context?.find(
      ([contextLineNo]) => contextLineNo === lineNo,
    )?.[1];
    if (contextLine !== undefined) mapped.contextLine = contextLine;
  }
  if (!detail) {
    return mapped;
  }
  // Surrounding source lines need a line number; local variables do not.
  if (lineNo !== null) {
    const preContext = contextLinesWithin(
      frame,
      lineNo - DETAIL_CONTEXT_LINES,
      lineNo - 1,
    );
    const postContext = contextLinesWithin(
      frame,
      lineNo + 1,
      lineNo + DETAIL_CONTEXT_LINES,
    );
    if (preContext) mapped.preContext = preContext;
    if (postContext) mapped.postContext = postContext;
  }
  const vars = mapVars(frame.vars);
  if (vars) mapped.vars = vars;
  return mapped;
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

/**
 * Maps a stacktrace. With `detail`, the most relevant frame (the last in-app
 * frame, as Sentry picks it) also gets its surrounding context and variables.
 */
export function mapStructuredStacktrace(
  stacktrace: Stacktrace | null | undefined,
  { detail = true }: { detail?: boolean } = {},
): StructuredStacktrace | null {
  if (!stacktrace?.frames.length) {
    return null;
  }
  const { frames } = stacktrace;
  const relevantFrame = detail ? findMostRelevantInAppFrame(frames) : undefined;
  return {
    frames: frames.map((frame) =>
      mapStructuredFrame(frame, { detail: frame === relevantFrame }),
    ),
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
    frameCount: thread.stacktrace?.frames.length ?? 0,
  };
}

export function mapStructuredThread(thread: Thread): StructuredThread {
  return {
    ...mapStructuredThreadSummary(thread),
    stacktrace: mapStructuredStacktrace(thread.stacktrace),
  };
}
