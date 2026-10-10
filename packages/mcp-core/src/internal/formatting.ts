/**
 * LLM response formatting utilities for Sentry data.
 *
 * Converts Sentry API responses into structured markdown format optimized
 * for LLM consumption. Handles stacktraces, event details, issue summaries,
 * and contextual information with consistent formatting patterns.
 */
import type { z } from "zod";
import type {
  DefaultEventSchema,
  ErrorEntrySchema,
  ErrorEventSchema,
  EventSchema,
  FrameInterface,
  GenericEventSchema,
  MessageEntrySchema,
  RequestEntrySchema,
  SentryApiService,
  ThreadEntrySchema,
} from "../api-client";
import { ThreadsEntrySchema } from "../api-client";
import type {
  AutofixRunState,
  CommitterList,
  Event,
  ExternalIssueList,
  GenericEvent,
  Issue,
  Trace,
  TraceSpan,
} from "../api-client/types";
import { logIssue } from "../telem/logging";
import {
  type CodeLocation,
  findMostRelevantInAppFrame,
  formatCodeLocation,
} from "./code-location";
import {
  type AIConversationReference,
  formatAIConversationActionInstructions,
} from "./tool-helpers/ai-conversation-actions";
import {
  getAutofixArtifactSummaries,
  getStatusDisplayName,
  isTerminalStatus,
  wrapSeerContent,
} from "./tool-helpers/seer";
import { formatToolCallInstruction } from "./tool-helpers/tool-call-formatting";
import { isPlainObject } from "./type-guards";
import { formatUserGeoSummary } from "./user-formatting";

/**
 * Convert Seer fixability score to actionability label.
 * Thresholds match Sentry core: src/sentry/seer/autofix/constants.py
 */
export function getSeerActionabilityLabel(score: number): string {
  if (score > 0.76) return "super_high";
  if (score > 0.66) return "high";
  if (score > 0.4) return "medium";
  if (score > 0.25) return "low";
  return "super_low";
}

// Language detection mappings
const LANGUAGE_EXTENSIONS: Record<string, string> = {
  ".java": "java",
  ".py": "python",
  ".js": "javascript",
  ".jsx": "javascript",
  ".ts": "javascript",
  ".tsx": "javascript",
  ".rb": "ruby",
  ".php": "php",
};

const LANGUAGE_MODULE_PATTERNS: Array<[RegExp, string]> = [
  [/^(java\.|com\.|org\.)/, "java"],
];

/**
 * Detects the programming language of a stack frame based on the file extension.
 * Falls back to the platform parameter if no filename is available or extension is unrecognized.
 *
 * @param frame - The stack frame containing file and location information
 * @param platform - Optional platform hint to use as fallback
 * @returns The detected language or platform fallback or "unknown"
 */
function detectLanguage(
  frame: z.infer<typeof FrameInterface>,
  platform?: string | null,
): string {
  // Check filename extensions
  if (frame.filename) {
    const ext = frame.filename.toLowerCase().match(/\.[^.]+$/)?.[0];
    if (ext && LANGUAGE_EXTENSIONS[ext]) {
      return LANGUAGE_EXTENSIONS[ext];
    }
  }

  // Check module patterns
  if (frame.module) {
    for (const [pattern, language] of LANGUAGE_MODULE_PATTERNS) {
      if (pattern.test(frame.module)) {
        return language;
      }
    }
  }

  // Fallback to platform or unknown
  return platform || "unknown";
}

/**
 * Formats a stack frame into a language-specific string representation.
 * Different languages have different conventions for displaying stack traces.
 *
 * @param frame - The stack frame to format
 * @param frameIndex - Optional frame index for languages that display frame numbers
 * @param platform - Optional platform hint for language detection fallback
 * @returns Formatted stack frame string
 */
export function formatFrameHeader(
  frame: z.infer<typeof FrameInterface>,
  frameIndex?: number,
  platform?: string | null,
) {
  const language = detectLanguage(frame, platform);

  switch (language) {
    case "java": {
      // at com.example.ClassName.methodName(FileName.java:123)
      const className = frame.module || "UnknownClass";
      const method = frame.function || "<unknown>";
      const source = frame.filename || "Unknown Source";
      const location = frame.lineNo ? `:${frame.lineNo}` : "";
      return `at ${className}.${method}(${source}${location})`;
    }

    case "python": {
      // File "/path/to/file.py", line 42, in function_name
      const file =
        frame.filename || frame.absPath || frame.module || "<unknown>";
      const func = frame.function || "<module>";
      const line = frame.lineNo ? `, line ${frame.lineNo}` : "";
      return `  File "${file}"${line}, in ${func}`;
    }

    case "javascript": {
      // Original compact format: filename:line:col (function)
      // This preserves backward compatibility
      return `${[frame.filename, frame.lineNo, frame.colNo]
        .filter((i) => !!i)
        .join(":")}${frame.function ? ` (${frame.function})` : ""}`;
    }

    case "ruby": {
      // from /path/to/file.rb:42:in `method_name'
      const file = frame.filename || frame.module || "<unknown>";
      const func = frame.function ? ` \`${frame.function}\`` : "";
      const line = frame.lineNo ? `:${frame.lineNo}:in` : "";
      return `    from ${file}${line}${func}`;
    }

    case "php": {
      // #0 /path/to/file.php(42): functionName()
      const file = frame.filename || "<unknown>";
      const line = frame.lineNo ? `(${frame.lineNo})` : "";
      const func = frame.function || "<unknown>";
      const prefix = frameIndex !== undefined ? `#${frameIndex} ` : "";
      return `${prefix}${file}${line}: ${func}()`;
    }

    default: {
      // Generic format for unknown languages
      const func = frame.function || "<unknown>";
      const location = frame.filename || frame.module || "<unknown>";
      const line = frame.lineNo ? `:${frame.lineNo}` : "";
      const col = frame.colNo != null ? `:${frame.colNo}` : "";
      return `    at ${func} (${location}${line}${col})`;
    }
  }
}

/**
 * Whether the shared formatter covers this event type, and so whether its body should be used
 * instead of the local rendering.
 *
 * "default" is an error event without exception data, "generic" a performance regression or
 * metric issue, "csp" a Content Security Policy violation. Anything else (a transaction, most
 * notably) keeps the local path, which renders things the shared body does not carry such as
 * the fetched performance trace.
 */
/**
 * Whether to read the issue's metadata instead of its top level fields. Performance issues can
 * have various categories such as 'db_query', but the issueType starts with 'performance_'.
 *
 * It matters which side of this an issue falls on: metadata.value is a query pattern for a
 * performance issue and the exception message for an error, so reading it unconditionally
 * misnames the error text.
 */
export function isPerformanceIssueType(issue: {
  issueType?: string | null;
  issueCategory?: string | null;
}): boolean {
  return (
    issue.issueType?.startsWith("performance_") === true ||
    issue.issueCategory === "performance"
  );
}

export function usesSharedFormatterBody(event: { type?: unknown }): boolean {
  return (
    event.type === "error" ||
    event.type === "default" ||
    event.type === "generic" ||
    event.type === "csp"
  );
}

/**
 * Formats a Sentry event into a structured markdown output.
 * Includes error messages, stack traces, request info, and contextual data.
 *
 * @param event - The Sentry event to format
 * @param options - Additional formatting context
 * @returns Formatted markdown string
 */
export function formatEventOutput(
  event: Event,
  options?: {
    performanceTrace?: Trace;
    replaySummary?: {
      apiService: SentryApiService;
      organizationSlug: string;
      relatedReplayIds?: string[];
      experimentalMode?: boolean;
      availableToolNames?: ReadonlySet<string>;
      directToolNames?: ReadonlySet<string>;
    };
  },
) {
  let output = "";
  const eventUser = (
    event as Event & {
      user?: z.infer<typeof EventSchema>["user"];
    }
  ).user;
  const eventWithReplayMetadataStripped = options?.replaySummary
    ? stripReplayMetadata(event)
    : event;
  const eventToRender = eventWithReplayMetadataStripped;

  if (options?.replaySummary) {
    output += formatIssueReplayOutput({
      apiService: options.replaySummary.apiService,
      organizationSlug: options.replaySummary.organizationSlug,
      event,
      relatedReplayIds: options.replaySummary.relatedReplayIds,
      experimentalMode: options.replaySummary.experimentalMode ?? false,
      availableToolNames: options.replaySummary.availableToolNames,
      directToolNames: options.replaySummary.directToolNames,
    });
  }

  // Check if entries exist (may be undefined for unsupported event types)
  if (!eventToRender.entries || !Array.isArray(eventToRender.entries)) {
    // For unsupported event types, just show tags and contexts
    output += formatEventUser(eventUser);
    output += formatTags(eventToRender.tags);
    output += formatContext(eventToRender.context);
    output += formatContexts(eventToRender.contexts);
    return output;
  }

  // Look for the primary error information
  const messageEntry = eventToRender.entries.find((e) => e.type === "message");
  const exceptionEntry = eventToRender.entries.find(
    (e) => e.type === "exception",
  );
  const threadsEntry = eventToRender.entries.find((e) => e.type === "threads");
  const threadsData = threadsEntry
    ? parseThreadsEntryData(threadsEntry.data)
    : undefined;
  const requestEntry = eventToRender.entries.find((e) => e.type === "request");
  const spansEntry = eventToRender.entries.find((e) => e.type === "spans");
  const cspEntry = eventToRender.entries.find((e) => e.type === "csp");

  // Error message (if present)
  if (messageEntry) {
    output += formatMessageInterfaceOutput(
      eventToRender,
      messageEntry.data as z.infer<typeof MessageEntrySchema>,
    );
  }

  // Stack trace (from exception or threads)
  if (exceptionEntry) {
    output += formatExceptionInterfaceOutput(
      eventToRender,
      exceptionEntry.data as z.infer<typeof ErrorEntrySchema>,
    );
  } else if (threadsData) {
    output += formatThreadsInterfaceOutput(eventToRender, threadsData);
  }

  if (threadsData?.values && threadsData.values.length > 1) {
    output += formatThreadList(threadsData.values);
    output += "\n";
  }

  // Request info (if HTTP error)
  if (requestEntry) {
    output += formatRequestInterfaceOutput(
      eventToRender,
      requestEntry.data as z.infer<typeof RequestEntrySchema>,
    );
  }

  // CSP violation details
  if (cspEntry) {
    output += formatCspInterfaceOutput(eventToRender, cspEntry.data);
  }

  // Performance issue details (N+1 queries, etc.)
  // Pass spans data for additional context even if we have evidence
  if (eventToRender.type === "transaction") {
    output += formatPerformanceIssueOutput(
      eventToRender,
      spansEntry?.data,
      options,
    );
  }

  // Generic events (performance regressions, metric-based issues)
  // These have occurrence data with evidenceDisplay that needs formatting
  if (eventToRender.type === "generic") {
    output += formatGenericEventOutput(eventToRender);
  }

  output += formatEventUser(eventUser);
  output += formatTags(eventToRender.tags);
  output += formatContext(eventToRender.context);
  output += formatContexts(eventToRender.contexts);
  return output;
}

/**
 * Extracts the context line matching the frame's line number for inline display.
 * This is used in the full stacktrace view to show the actual line of code
 * that caused the error inline with the stack frame.
 *
 * @param frame - The stack frame containing context lines
 * @returns The line of code at the frame's line number, or empty string if not available
 */
function renderInlineContext(frame: z.infer<typeof FrameInterface>): string {
  if (!frame.context?.length || !frame.lineNo) {
    return "";
  }

  const contextLine = frame.context.find(([lineNo]) => lineNo === frame.lineNo);
  return contextLine ? `\n${contextLine[1]}` : "";
}

/**
 * Renders an enhanced view of a stack frame with context lines and variables.
 * Used for the "Most Relevant Frame" section to provide detailed information
 * about the most relevant application frame where the error occurred.
 *
 * @param frame - The stack frame to render with enhanced information
 * @param event - The Sentry event containing platform information for language detection
 * @returns Formatted string with frame header, context lines, and variables table
 */
function renderEnhancedFrame(
  frame: z.infer<typeof FrameInterface>,
  event: Event,
): string {
  const parts: string[] = [];

  parts.push("**Most Relevant Frame:**");
  parts.push("─────────────────────");
  parts.push(formatFrameHeader(frame, undefined, event.platform));

  // Add context lines if available
  if (frame.context?.length) {
    const contextLines = renderContextLines(frame);
    if (contextLines) {
      parts.push("");
      parts.push(contextLines);
    }
  }

  // Add variables table if available
  if (frame.vars && Object.keys(frame.vars).length > 0) {
    parts.push("");
    parts.push(renderVariablesTable(frame.vars));
  }

  return parts.join("\n");
}

function formatExceptionInterfaceOutput(
  event: Event,
  data: z.infer<typeof ErrorEntrySchema>,
) {
  const parts: string[] = [];

  // Handle both single exception (value) and chained exceptions (values)
  const exceptions = data.values || (data.value ? [data.value] : []);

  if (exceptions.length === 0) {
    return "";
  }

  // For chained exceptions, they are typically ordered from innermost to outermost
  // We'll render them in reverse order (outermost first) to match how they occurred
  const isChained = exceptions.length > 1;

  // Create a copy before reversing to avoid mutating the original array
  [...exceptions].reverse().forEach((exception, index) => {
    if (!exception) return;

    // Add language-specific chain indicator for multiple exceptions
    if (isChained && index > 0) {
      parts.push("");
      parts.push(
        getExceptionChainMessage(
          event.platform || null,
          index,
          exceptions.length,
        ),
      );
      parts.push("");
    }

    // Use the actual exception type and value as the heading
    const exceptionTitle = `${exception.type}${exception.value ? `: ${exception.value}` : ""}`;

    parts.push(index === 0 ? "### Error" : `### ${exceptionTitle}`);
    parts.push("");

    // Add the error details in a code block for the first exception
    // to maintain backward compatibility
    if (index === 0) {
      parts.push("```");
      parts.push(exceptionTitle);
      parts.push("```");
      parts.push("");
    }

    if (!exception.stacktrace || !exception.stacktrace.frames) {
      parts.push("**Stacktrace:**");
      parts.push("```");
      parts.push("No stacktrace available");
      parts.push("```");
      return;
    }

    const frames = exception.stacktrace.frames;

    // Only show enhanced frame for the first (outermost) exception to avoid overwhelming output
    if (index === 0) {
      const relevantFrame = findMostRelevantInAppFrame(frames);
      if (
        relevantFrame &&
        (relevantFrame.context?.length || relevantFrame.vars)
      ) {
        parts.push(renderEnhancedFrame(relevantFrame, event));
        parts.push("");
        parts.push("**Full Stacktrace:**");
        parts.push("────────────────");
      } else {
        parts.push("**Stacktrace:**");
      }
    } else {
      parts.push("**Stacktrace:**");
    }

    parts.push("```");
    parts.push(
      frames
        .map((frame) => {
          const header = formatFrameHeader(frame, undefined, event.platform);
          const context = renderInlineContext(frame);
          return `${header}${context}`;
        })
        .join("\n"),
    );
    parts.push("```");
  });

  parts.push("");
  parts.push("");

  return parts.join("\n");
}

/**
 * Get the appropriate exception chain message based on the platform
 */
function getExceptionChainMessage(
  platform: string | null,
  index: number,
  totalExceptions: number,
): string {
  // Default message for unknown platforms
  const defaultMessage =
    "**During handling of the above exception, another exception occurred:**";

  if (!platform) {
    return defaultMessage;
  }

  switch (platform.toLowerCase()) {
    case "python":
      // Python has two distinct messages, but without additional metadata
      // we default to the implicit chaining message
      return "**During handling of the above exception, another exception occurred:**";

    case "java":
      return "**Caused by:**";

    case "csharp":
    case "dotnet":
      return "**---> Inner Exception:**";

    case "ruby":
      return "**Caused by:**";

    case "go":
      return "**Wrapped error:**";

    case "rust":
      return `**Caused by (${index}):**`;

    default:
      return defaultMessage;
  }
}

function formatCspInterfaceOutput(event: Event, data: any) {
  if (!data) {
    return "";
  }

  const parts: string[] = [];
  parts.push("### CSP Violation");
  parts.push("");

  if (data.blocked_uri) {
    parts.push(`**Blocked URI**: ${data.blocked_uri}`);
  }

  if (data.violated_directive) {
    parts.push(`**Violated Directive**: ${data.violated_directive}`);
  }

  if (data.effective_directive) {
    parts.push(`**Effective Directive**: ${data.effective_directive}`);
  }

  if (data.document_uri) {
    parts.push(`**Document URI**: ${data.document_uri}`);
  }

  if (data.source_file) {
    parts.push(`**Source File**: ${data.source_file}`);
    if (data.line_number) {
      parts.push(`**Line Number**: ${data.line_number}`);
    }
  }

  if (data.disposition) {
    parts.push(`**Disposition**: ${data.disposition}`);
  }

  if (data.original_policy) {
    parts.push("");
    parts.push("**Original Policy:**");
    parts.push("```");
    parts.push(data.original_policy);
    parts.push("```");
  }

  parts.push("");
  parts.push("");

  return parts.join("\n");
}

function formatRequestInterfaceOutput(
  event: Event,
  data: z.infer<typeof RequestEntrySchema>,
) {
  if (!data.method || !data.url) {
    return "";
  }
  return `### HTTP Request\n\n**Method:** ${data.method}\n**URL:** ${data.url}\n\n`;
}

function formatMessageInterfaceOutput(
  event: Event,
  data: z.infer<typeof MessageEntrySchema>,
) {
  if (!data.formatted && !data.message) {
    return "";
  }
  const message = data.formatted || data.message || "";
  return `### Error\n\n${"```"}\n${message}\n${"```"}\n\n`;
}

function formatThreadsInterfaceOutput(
  event: Event,
  data: z.infer<typeof ThreadsEntrySchema>,
) {
  if (!data.values || data.values.length === 0) {
    return "";
  }

  // Find the crashed thread only
  const crashedThread = data.values.find((t) => t.crashed);

  if (!crashedThread?.stacktrace?.frames) {
    return "";
  }

  const parts: string[] = [];

  // Include thread name if available
  if (crashedThread.name) {
    parts.push(`**Thread** (${crashedThread.name})`);
    parts.push("");
  }

  const frames = crashedThread.stacktrace.frames;

  // Find and format the most relevant in-app frame with enhanced view
  const relevantFrame = findMostRelevantInAppFrame(frames);
  if (relevantFrame && (relevantFrame.context?.length || relevantFrame.vars)) {
    parts.push(renderEnhancedFrame(relevantFrame, event));
    parts.push("");
    parts.push("**Full Stacktrace:**");
    parts.push("────────────────");
  } else {
    parts.push("**Stacktrace:**");
  }

  parts.push("```");
  parts.push(
    frames
      .map((frame) => {
        const header = formatFrameHeader(frame, undefined, event.platform);
        const context = renderInlineContext(frame);
        return `${header}${context}`;
      })
      .join("\n"),
  );
  parts.push("```");
  parts.push("");

  return parts.join("\n");
}

function getThreadDisplayValue(
  value: string | number | boolean | null | undefined,
): string {
  if (value === null || value === undefined || value === "") {
    return "-";
  }
  return String(value);
}

function getThreadFlags(thread: z.infer<typeof ThreadEntrySchema>): string {
  const flags: string[] = [];
  if (thread.crashed) {
    flags.push("crashed");
  }
  if (thread.current) {
    flags.push("current");
  }
  return flags.length > 0 ? flags.join(", ") : "-";
}

function formatThreadList(
  threads: z.infer<typeof ThreadEntrySchema>[],
): string {
  return [
    "### Threads",
    "",
    `Found ${threads.length} thread${threads.length === 1 ? "" : "s"} in this event.`,
    "",
    ...formatThreadTable(threads),
    "",
  ].join("\n");
}

function formatThreadTable(
  threads: z.infer<typeof ThreadEntrySchema>[],
): string[] {
  return [
    "| Thread ID | Name | State | Flags | Frames |",
    "| --- | --- | --- | --- | ---: |",
    ...threads.map((thread) => {
      const frameCount = thread.stacktrace?.frames?.length ?? 0;
      return `| ${getThreadDisplayValue(thread.id)} | ${getThreadDisplayValue(thread.name)} | ${getThreadDisplayValue(thread.state)} | ${getThreadFlags(thread)} | ${frameCount} |`;
    }),
  ];
}

export function formatAvailableThreadList(
  threads: z.infer<typeof ThreadEntrySchema>[],
): string {
  return [
    "## Available Threads",
    "",
    ...formatThreadTable(threads),
    "",
    "Pass `thread` as a numeric Thread ID or exact thread Name.",
  ].join("\n");
}

function parseThreadsEntryData(
  data: unknown,
): z.infer<typeof ThreadsEntrySchema> | undefined {
  const result = ThreadsEntrySchema.safeParse(data);
  return result.success ? result.data : undefined;
}

/**
 * Formats the selected thread stacktrace using the same frame rendering
 * conventions as issue event details.
 */
export function formatThreadStacktraceOutput({
  event,
  thread,
  selectionReason,
}: {
  event: Event;
  thread: z.infer<typeof ThreadEntrySchema>;
  selectionReason: string;
}): string {
  const parts: string[] = [];

  parts.push("## Selected Thread");
  parts.push("");
  parts.push(`**Selection**: ${selectionReason}`);
  parts.push(`**Thread ID**: ${getThreadDisplayValue(thread.id)}`);
  parts.push(`**Name**: ${getThreadDisplayValue(thread.name)}`);
  parts.push(`**State**: ${getThreadDisplayValue(thread.state)}`);
  parts.push(`**Crashed**: ${getThreadDisplayValue(thread.crashed)}`);
  parts.push(`**Current**: ${getThreadDisplayValue(thread.current)}`);
  parts.push("");

  const frames = thread.stacktrace?.frames;
  if (!frames || frames.length === 0) {
    parts.push("No stacktrace is available for the selected thread.");
    parts.push("");
    return parts.join("\n");
  }

  parts.push("## Stacktrace");
  parts.push("");
  const framesOmitted = formatFramesOmitted(thread.stacktrace?.framesOmitted);
  if (framesOmitted) {
    parts.push(`**Frames Omitted**: ${framesOmitted}`);
    parts.push("");
  }

  const relevantFrame = findMostRelevantInAppFrame(frames);
  if (relevantFrame && (relevantFrame.context?.length || relevantFrame.vars)) {
    parts.push(renderEnhancedFrame(relevantFrame, event));
    parts.push("");
    parts.push("**Full Stacktrace:**");
    parts.push("────────────────");
  } else {
    parts.push("**Full Stacktrace:**");
  }

  parts.push("```");
  parts.push(
    frames
      .map((frame) => {
        const header = formatFrameHeader(frame, undefined, event.platform);
        const context = renderInlineContext(frame);
        return `${header}${context}`;
      })
      .join("\n"),
  );
  parts.push("```");
  parts.push("");

  return parts.join("\n");
}

function formatFramesOmitted(
  framesOmitted: unknown[] | null | undefined,
): string | null {
  if (!framesOmitted?.length) {
    return null;
  }

  const [firstOmitted, lastOmitted] = framesOmitted;
  if (
    typeof firstOmitted === "number" &&
    typeof lastOmitted === "number" &&
    Number.isFinite(firstOmitted) &&
    Number.isFinite(lastOmitted)
  ) {
    return String(Math.max(0, lastOmitted - firstOmitted));
  }

  return null;
}

/**
 * Renders surrounding source code context for a stack frame.
 * Shows a window of code lines around the error line with visual indicators.
 *
 * @param frame - The stack frame containing context lines
 * @param contextSize - Number of lines to show before and after the error line (default: 3)
 * @returns Formatted context lines with line numbers and arrow indicator for the error line
 */
function renderContextLines(
  frame: z.infer<typeof FrameInterface>,
  contextSize = 3,
): string {
  if (!frame.context || frame.context.length === 0 || !frame.lineNo) {
    return "";
  }

  const lines: string[] = [];
  const errorLine = frame.lineNo;
  const maxLineNoWidth = Math.max(
    ...frame.context.map(([lineNo]) => lineNo.toString().length),
  );

  for (const [lineNo, code] of frame.context) {
    const isErrorLine = lineNo === errorLine;
    const lineNoStr = lineNo.toString().padStart(maxLineNoWidth, " ");

    if (Math.abs(lineNo - errorLine) <= contextSize) {
      if (isErrorLine) {
        lines.push(`  → ${lineNoStr} │ ${code}`);
      } else {
        lines.push(`    ${lineNoStr} │ ${code}`);
      }
    }
  }

  return lines.join("\n");
}

/**
 * Formats a variable value for display in the variables table.
 * Handles different types appropriately and safely, converting complex objects
 * to readable representations and handling edge cases like circular references.
 *
 * @param value - The variable value to format (can be any type)
 * @param maxLength - Maximum length for stringified objects/arrays (default: 80)
 * @returns Human-readable string representation of the value
 */
function formatVariableValue(value: unknown, maxLength = 80): string {
  try {
    if (typeof value === "string") {
      return `"${value}"`;
    }
    if (value === null) {
      return "null";
    }
    if (value === undefined) {
      return "undefined";
    }
    if (typeof value === "object") {
      const stringified = JSON.stringify(value);
      if (stringified.length > maxLength) {
        // Leave room for ", ...]" or ", ...}"
        const truncateAt = maxLength - 6;
        let truncated = stringified.substring(0, truncateAt);

        // Find the last complete element by looking for the last comma
        const lastComma = truncated.lastIndexOf(",");
        if (lastComma > 0) {
          truncated = truncated.substring(0, lastComma);
        }

        // Add the appropriate ending
        if (Array.isArray(value)) {
          return `${truncated}, ...]`;
        }
        return `${truncated}, ...}`;
      }
      return stringified;
    }
    return String(value);
  } catch {
    // Handle circular references or other stringify errors
    return `<${typeof value}>`;
  }
}

/**
 * Renders a table of local variables in a tree-like format.
 * Uses box-drawing characters to create a visual hierarchy of variables
 * and their values at the point where the error occurred.
 *
 * @param vars - Object containing variable names as keys and their values
 * @returns Formatted variables table with tree-style prefix characters
 */
function renderVariablesTable(vars: Record<string, unknown>): string {
  const entries = Object.entries(vars);
  if (entries.length === 0) {
    return "";
  }

  const lines: string[] = ["Local Variables:"];
  const lastIndex = entries.length - 1;

  entries.forEach(([key, value], index) => {
    const prefix = index === lastIndex ? "└─" : "├─";
    const valueStr = formatVariableValue(value);
    lines.push(`${prefix} ${key}: ${valueStr}`);
  });

  return lines.join("\n");
}

/**
 * Constants for performance issue formatting
 */
const MAX_SPANS_IN_TREE = 10;

/**
 * Safely parse a number from a string, returning a default if invalid
 */
function safeParseInt(value: unknown, defaultValue: number): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? defaultValue : parsed;
  }
  return defaultValue;
}

/**
 * Simplified span structure for rendering span trees in performance issues.
 * This is a subset of the full span data focused on visualization needs.
 */
interface PerformanceSpan {
  span_id: string;
  op: string; // Operation type (e.g., "db.query", "http.client")
  description: string; // Human-readable description of what the span did
  duration: number; // Duration in milliseconds
  is_n1_query: boolean; // Whether this span is part of the N+1 pattern
  children: PerformanceSpan[];
  level: number; // Nesting level for tree rendering
}

interface RawSpan {
  span_id?: string;
  id?: string;
  op?: string;
  description?: string;
  timestamp?: number;
  start_timestamp?: number;
  duration?: number;
}

interface N1EvidenceData {
  parentSpan?: string;
  parentSpanIds?: string[];
  repeatingSpansCompact?: string[];
  repeatingSpans?: string[];
  numberRepeatingSpans?: string; // API returns string even though it's a number
  numPatternRepetitions?: number;
  offenderSpanIds?: string[];
  transactionName?: string;
  [key: string]: unknown;
}

interface SlowDbEvidenceData {
  parentSpan?: string;
  [key: string]: unknown;
}

function normalizeSpanId(value: unknown): string | undefined {
  if (typeof value === "string" && value) {
    return value;
  }
  return undefined;
}

function getSpanIdentifier(span: RawSpan): string | undefined {
  if (span.span_id !== undefined) {
    return normalizeSpanId(span.span_id);
  }
  if (span.id !== undefined) {
    return normalizeSpanId(span.id);
  }
  return undefined;
}

function getSpanDurationMs(span: RawSpan): number {
  if (
    typeof span.timestamp === "number" &&
    typeof span.start_timestamp === "number"
  ) {
    const deltaSeconds = span.timestamp - span.start_timestamp;
    if (Number.isFinite(deltaSeconds) && deltaSeconds >= 0) {
      return deltaSeconds * 1000;
    }
  }

  // Trace APIs expose `duration` in milliseconds. Preserve fractional values.
  if (typeof span.duration === "number" && Number.isFinite(span.duration)) {
    return span.duration >= 0 ? span.duration : 0;
  }

  return 0;
}

function normalizeIdArray(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => normalizeSpanId(value))
    .filter((value): value is string => value !== undefined);
}

function isValidSpanArray(value: unknown): value is RawSpan[] {
  return Array.isArray(value);
}

/**
 * Get the repeating span descriptions from evidence data.
 * Prefers repeatingSpansCompact (more concise) over repeatingSpans (verbose).
 */
function getRepeatingSpanLines(evidenceData: N1EvidenceData): string[] {
  // Try compact version first (preferred for display)
  if (
    Array.isArray(evidenceData.repeatingSpansCompact) &&
    evidenceData.repeatingSpansCompact.length > 0
  ) {
    return evidenceData.repeatingSpansCompact
      .map((s) => (typeof s === "string" ? s.trim() : ""))
      .filter((s): s is string => s.length > 0);
  }

  // Fall back to full version
  if (
    Array.isArray(evidenceData.repeatingSpans) &&
    evidenceData.repeatingSpans.length > 0
  ) {
    return evidenceData.repeatingSpans
      .map((s) => (typeof s === "string" ? s.trim() : ""))
      .filter((s): s is string => s.length > 0);
  }

  return [];
}

function isTraceSpan(node: unknown): node is TraceSpan {
  if (node === null || typeof node !== "object") {
    return false;
  }
  const candidate = node as { event_type?: unknown; event_id?: unknown };
  // Trace API returns spans with event_type: "span"
  return (
    candidate.event_type === "span" && typeof candidate.event_id === "string"
  );
}

function buildTraceSpanTree(
  trace: Trace,
  parentSpanIds: string[],
  offenderSpanIds: string[],
  maxSpans: number,
): string[] {
  const offenderSet = new Set(offenderSpanIds);
  const spanMap = new Map<string, TraceSpan>();

  function indexSpan(span: TraceSpan): void {
    // Try to get span_id from additional_attributes, fall back to event_id
    const spanId =
      normalizeSpanId(span.additional_attributes?.span_id) || span.event_id;
    if (spanId && spanId.length > 0) {
      spanMap.set(spanId, span);
    }
    for (const child of span.children ?? []) {
      if (isTraceSpan(child)) {
        indexSpan(child);
      }
    }
  }

  for (const node of trace) {
    if (isTraceSpan(node)) {
      indexSpan(node);
    }
  }

  const roots: PerformanceSpan[] = [];
  const budget = { count: 0, limit: maxSpans };

  // First, try to find parent spans
  for (const parentId of parentSpanIds) {
    const span = spanMap.get(parentId);
    if (!span) {
      continue;
    }
    const perfSpan = convertTraceSpanToPerformanceSpan(
      span,
      offenderSet,
      budget,
      0,
    );
    if (perfSpan) {
      roots.push(perfSpan);
    }
    if (budget.count >= budget.limit) {
      break;
    }
  }

  // If no parent spans found, try to find offender spans directly
  if (roots.length === 0 && offenderSpanIds.length > 0) {
    for (const offenderId of offenderSpanIds) {
      const span = spanMap.get(offenderId);
      if (!span) {
        continue;
      }
      const perfSpan = convertTraceSpanToPerformanceSpan(
        span,
        offenderSet,
        budget,
        0,
      );
      if (perfSpan) {
        roots.push(perfSpan);
      }
      if (budget.count >= budget.limit) {
        break;
      }
    }
  }

  if (roots.length === 0) {
    return [];
  }

  return renderPerformanceSpanTree(roots);
}

function convertTraceSpanToPerformanceSpan(
  span: TraceSpan,
  offenderSet: Set<string>,
  budget: { count: number; limit: number },
  level: number,
): PerformanceSpan | null {
  if (budget.count >= budget.limit) {
    return null;
  }

  budget.count += 1;

  // Get span ID from additional_attributes or fall back to event_id
  const spanId =
    normalizeSpanId(span.additional_attributes?.span_id) || span.event_id;

  const performanceSpan: PerformanceSpan = {
    span_id: spanId,
    op: span.op || "unknown",
    description: formatTraceSpanDescription(span),
    duration: getTraceSpanDurationMs(span),
    is_n1_query: offenderSet.has(spanId),
    children: [],
    level,
  };

  for (const child of span.children ?? []) {
    if (!isTraceSpan(child)) {
      continue;
    }
    if (budget.count >= budget.limit) {
      break;
    }
    const childSpan = convertTraceSpanToPerformanceSpan(
      child,
      offenderSet,
      budget,
      level + 1,
    );
    if (childSpan) {
      performanceSpan.children.push(childSpan);
    }
    if (budget.count >= budget.limit) {
      break;
    }
  }

  return performanceSpan;
}

function formatTraceSpanDescription(span: TraceSpan): string {
  if (span.name && span.name.trim().length > 0) {
    return span.name.trim();
  }
  if (span.description && span.description.trim().length > 0) {
    return span.description.trim();
  }
  if (span.op && span.op.trim().length > 0) {
    return span.op.trim();
  }
  return "unnamed";
}

function getTraceSpanDurationMs(span: TraceSpan): number {
  if (typeof span.duration === "number" && span.duration >= 0) {
    return span.duration;
  }
  if (
    typeof (span as { end_timestamp?: number }).end_timestamp === "number" &&
    typeof span.start_timestamp === "number"
  ) {
    const deltaSeconds =
      (span as { end_timestamp: number }).end_timestamp - span.start_timestamp;
    if (Number.isFinite(deltaSeconds) && deltaSeconds >= 0) {
      return deltaSeconds * 1000;
    }
  }
  return 0;
}

function buildOffenderSummaries(
  spans: RawSpan[],
  offenderSpanIds: string[],
): string[] {
  if (offenderSpanIds.length === 0) {
    return [];
  }

  const spanMap = new Map<string, RawSpan>();
  for (const span of spans) {
    const identifier = getSpanIdentifier(span);
    if (identifier) {
      spanMap.set(identifier, span);
    }
  }

  const summaries: string[] = [];
  for (const offenderId of offenderSpanIds) {
    const span = spanMap.get(offenderId);
    if (span) {
      const description = span.description || span.op || `Span ${offenderId}`;
      const duration = getSpanDurationMs(span);
      const durationLabel = duration > 0 ? ` (${Math.round(duration)}ms)` : "";
      summaries.push(`${description}${durationLabel} [${offenderId}] [N+1]`);
    } else {
      summaries.push(`Span ${offenderId} [N+1]`);
    }
  }

  return summaries;
}

/**
 * Renders a hierarchical tree of performance spans using box-drawing characters.
 * Highlights N+1 queries with a special indicator.
 *
 * @param spans - Array of selected performance spans
 * @returns Array of formatted strings representing the tree
 */
function renderPerformanceSpanTree(spans: PerformanceSpan[]): string[] {
  const lines: string[] = [];

  function renderSpan(span: PerformanceSpan, prefix = "", isLast = true): void {
    const connector = prefix === "" ? "" : isLast ? "└─ " : "├─ ";

    const displayName = span.description?.trim() || span.op || "unnamed";
    const spanId = span.span_id ?? "unknown";
    const durationDisplay =
      span.duration > 0 ? `${Math.round(span.duration)}ms` : "unknown";

    // Full span ID goes last so human-readable parts read first.
    const metadataParts: string[] = [];
    if (span.op && span.op !== "default") {
      metadataParts.push(span.op);
    }
    metadataParts.push(durationDisplay, spanId);

    const line = `${prefix}${connector}${displayName} [${metadataParts.join(
      " · ",
    )}]${span.is_n1_query ? " [N+1]" : ""}`;
    lines.push(line);

    // Render children
    for (let i = 0; i < span.children.length; i++) {
      const child = span.children[i];
      const isLastChild = i === span.children.length - 1;
      const childPrefix = prefix + (isLast ? "   " : "│  ");
      renderSpan(child, childPrefix, isLastChild);
    }
  }

  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    const isLastRoot = i === spans.length - 1;
    renderSpan(span, "", isLastRoot);
  }

  return lines;
}

function selectN1QuerySpans(
  spans: RawSpan[],
  evidence: N1EvidenceData,
  maxSpans = MAX_SPANS_IN_TREE,
): PerformanceSpan[] {
  const selected: PerformanceSpan[] = [];
  let spanCount = 0;

  const offenderSpanIds = normalizeIdArray(evidence.offenderSpanIds);
  const parentSpanIds = normalizeIdArray(evidence.parentSpanIds);

  let parentSpan: PerformanceSpan | null = null;
  if (parentSpanIds.length > 0) {
    const parent = spans.find((span) => {
      const identifier = getSpanIdentifier(span);
      return identifier ? parentSpanIds.includes(identifier) : false;
    });

    if (parent) {
      parentSpan = {
        span_id: getSpanIdentifier(parent) ?? "unknown",
        op: parent.op || "unknown",
        description:
          parent.description || evidence.parentSpan || "Parent Operation",
        duration: getSpanDurationMs(parent),
        is_n1_query: false,
        children: [],
        level: 0,
      };
      selected.push(parentSpan);
      spanCount += 1;
    }
  }

  if (offenderSpanIds.length > 0) {
    const offenderSet = new Set(offenderSpanIds);
    const offenderSpans = spans
      .filter((span) => {
        const identifier = getSpanIdentifier(span);
        return identifier ? offenderSet.has(identifier) : false;
      })
      .slice(0, Math.max(0, maxSpans - spanCount));

    for (const span of offenderSpans) {
      const perfSpan: PerformanceSpan = {
        span_id: getSpanIdentifier(span) ?? "unknown",
        op: span.op || "db.query",
        description: span.description || "Database Query",
        duration: getSpanDurationMs(span),
        is_n1_query: true,
        children: [],
        level: parentSpan ? 1 : 0,
      };

      if (parentSpan) {
        parentSpan.children.push(perfSpan);
      } else {
        selected.push(perfSpan);
      }

      spanCount += 1;
      if (spanCount >= maxSpans) {
        break;
      }
    }
  }

  return selected;
}

/**
 * Known Sentry performance issue types that we handle.
 *
 * NOTE: We intentionally only implement formatters for high-value performance issues
 * that provide complex insights. Not all issue types need custom formatting - many
 * can rely on the generic evidenceDisplay fields that Sentry provides.
 *
 * Currently fully implemented:
 * - N+1 query detection (DB and API)
 *
 * Partially implemented:
 * - Slow DB queries (shows parent span only)
 *
 * Not implemented (lower priority):
 * - Asset-related issues (render blocking, uncompressed, large payloads)
 * - File I/O issues
 * - Consecutive queries
 */
const KNOWN_PERFORMANCE_ISSUE_TYPES = {
  N_PLUS_ONE_DB_QUERIES: "performance_n_plus_one_db_queries",
  N_PLUS_ONE_API_CALLS: "performance_n_plus_one_api_calls",
  SLOW_DB_QUERY: "performance_slow_db_query",
  RENDER_BLOCKING_ASSET: "performance_render_blocking_asset",
  CONSECUTIVE_DB_QUERIES: "performance_consecutive_db_queries",
  FILE_IO_MAIN_THREAD: "performance_file_io_main_thread",
  M_N_PLUS_ONE_DB_QUERIES: "performance_m_n_plus_one_db_queries",
  UNCOMPRESSED_ASSET: "performance_uncompressed_asset",
  LARGE_HTTP_PAYLOAD: "performance_large_http_payload",
} as const;

/**
 * Map numeric occurrence types to issue types (from Sentry's codebase).
 *
 * Sentry uses numeric type IDs internally in the occurrence data structure,
 * but string issue types in the UI and other APIs. This mapping converts
 * between them.
 *
 * Source: sentry/static/app/types/group.tsx in Sentry's codebase
 * Range: 1xxx = transaction-based performance issues
 *        2xxx = profile-based performance issues
 */
const OCCURRENCE_TYPE_TO_ISSUE_TYPE: Record<number, string> = {
  1001: KNOWN_PERFORMANCE_ISSUE_TYPES.SLOW_DB_QUERY,
  1004: KNOWN_PERFORMANCE_ISSUE_TYPES.RENDER_BLOCKING_ASSET,
  1006: KNOWN_PERFORMANCE_ISSUE_TYPES.N_PLUS_ONE_DB_QUERIES,
  1906: KNOWN_PERFORMANCE_ISSUE_TYPES.N_PLUS_ONE_DB_QUERIES, // Alternative ID for N+1 DB
  1007: KNOWN_PERFORMANCE_ISSUE_TYPES.CONSECUTIVE_DB_QUERIES,
  1008: KNOWN_PERFORMANCE_ISSUE_TYPES.FILE_IO_MAIN_THREAD,
  1009: "performance_consecutive_http",
  1010: KNOWN_PERFORMANCE_ISSUE_TYPES.N_PLUS_ONE_API_CALLS,
  1910: KNOWN_PERFORMANCE_ISSUE_TYPES.N_PLUS_ONE_API_CALLS, // Alternative ID for N+1 API
  1012: KNOWN_PERFORMANCE_ISSUE_TYPES.UNCOMPRESSED_ASSET,
  1013: "performance_db_main_thread",
  1015: KNOWN_PERFORMANCE_ISSUE_TYPES.LARGE_HTTP_PAYLOAD,
  1016: "performance_http_overhead",
};

// Type alias currently unused but kept for potential future type safety
// type PerformanceIssueType = typeof KNOWN_PERFORMANCE_ISSUE_TYPES[keyof typeof KNOWN_PERFORMANCE_ISSUE_TYPES];

/**
 * Formats N+1 query issue evidence data.
 *
 * N+1 queries are a common performance anti-pattern where code executes
 * 1 query to get a list of items, then N additional queries (one per item)
 * instead of using a single JOIN or batch query.
 *
 * Evidence fields we use:
 * - parentSpan: The operation that triggered the N+1 queries
 * - repeatingSpansCompact/repeatingSpans: The query pattern being repeated
 * - numberRepeatingSpans: How many times the query was executed
 * - offenderSpanIds: IDs of the actual span instances
 * - parentSpanIds: IDs of parent spans for tree visualization
 */
function formatN1QueryEvidence(
  evidenceData: N1EvidenceData,
  spansData: unknown,
  performanceTrace?: Trace,
): string {
  const parts: string[] = [];

  // Format parent span info if available
  if (evidenceData.parentSpan) {
    parts.push("**Parent Operation:**");
    parts.push(`${evidenceData.parentSpan}`);
    parts.push("");
  }

  // Format repeating spans (the N+1 queries)
  const repeatingLines = getRepeatingSpanLines(evidenceData);
  if (repeatingLines.length > 0) {
    parts.push("### Repeated Database Queries");
    parts.push("");

    const queryCount = evidenceData.numberRepeatingSpans
      ? safeParseInt(evidenceData.numberRepeatingSpans, 0)
      : evidenceData.numPatternRepetitions ||
        evidenceData.offenderSpanIds?.length ||
        0;

    if (queryCount > 0) {
      parts.push(`**Query executed ${queryCount} times:**`);
    }

    // Show the query pattern - if single line, render as SQL block; if multiple, as list
    if (repeatingLines.length === 1) {
      parts.push("```sql");
      parts.push(repeatingLines[0]);
      parts.push("```");
      parts.push("");
    } else {
      parts.push("**Repeated operations:**");
      for (const line of repeatingLines) {
        parts.push(`- ${line}`);
      }
      parts.push("");
    }
  }

  const parentSpanIds = normalizeIdArray(evidenceData.parentSpanIds);
  const offenderSpanIds = normalizeIdArray(evidenceData.offenderSpanIds);

  const traceLines = performanceTrace
    ? buildTraceSpanTree(
        performanceTrace,
        parentSpanIds,
        offenderSpanIds,
        MAX_SPANS_IN_TREE,
      )
    : [];

  if (traceLines.length > 0) {
    parts.push(`### Span Tree (Limited to ${MAX_SPANS_IN_TREE} spans)`);
    parts.push("");
    parts.push("```");
    parts.push(...traceLines);
    parts.push("```");
    parts.push("");
  } else {
    const spanTree = isValidSpanArray(spansData)
      ? selectN1QuerySpans(spansData, evidenceData, MAX_SPANS_IN_TREE)
      : [];

    if (spanTree.length > 0) {
      parts.push(`### Span Tree (Limited to ${MAX_SPANS_IN_TREE} spans)`);
      parts.push("");
      parts.push("```");
      parts.push(...renderPerformanceSpanTree(spanTree));
      parts.push("```");
      parts.push("");
    } else if (isValidSpanArray(spansData)) {
      // Only show offender summaries if we have spans data but couldn't build a tree
      const offenderSummaries = buildOffenderSummaries(
        spansData as RawSpan[],
        offenderSpanIds,
      );

      if (offenderSummaries.length > 0) {
        parts.push("### Offending Spans");
        parts.push("");
        for (const summary of offenderSummaries) {
          parts.push(`- ${summary}`);
        }
      }
    }
  }

  return parts.join("\n");
}

/**
 * Formats slow DB query issue evidence data.
 *
 * Currently only partially implemented - shows parent span information.
 * Full implementation would show query duration, explain plan, etc.
 *
 * This is lower priority as the generic evidenceDisplay fields usually
 * provide sufficient information for slow query issues.
 */
function formatSlowDbQueryEvidence(
  evidenceData: SlowDbEvidenceData,
  spansData: unknown,
): string {
  const parts: string[] = [];

  // Show parent span if available (generic field that applies to slow queries)
  if (evidenceData.parentSpan) {
    parts.push("**Parent Operation:**");
    parts.push(`${evidenceData.parentSpan}`);
    parts.push("");
  }

  // TODO: Implement slow query specific fields when we know the structure
  // Potential fields: query duration, database name, query plan
  console.warn(
    "[formatSlowDbQueryEvidence] Evidence data rendering not yet fully implemented",
  );

  return parts.join("\n");
}

/**
 * Formats performance issue details from transaction events based on the issue type.
 *
 * This is the main dispatcher for performance issue formatting. It:
 * 1. Detects the issue type from occurrence data (numeric or string)
 * 2. Calls the appropriate type-specific formatter if implemented
 * 3. Falls back to generic evidenceDisplay fields for unimplemented types
 * 4. Provides span analysis fallback for events without occurrence data
 *
 * The occurrence data structure comes from Sentry's performance issue detection
 * and contains evidence about what triggered the issue.
 *
 * @param event - The transaction event containing performance issue data
 * @param spansData - The spans data from the event entries
 * @returns Formatted markdown string with performance issue details
 */
function formatPerformanceIssueOutput(
  event: Event,
  spansData: unknown,
  options?: {
    performanceTrace?: Trace;
  },
): string {
  const parts: string[] = [];

  // Check if we have occurrence data
  const occurrence = (event as any).occurrence;
  if (!occurrence) {
    return "";
  }

  // Get issue type - occurrence.type is numeric, issueType may be a string
  let issueType: string | undefined;
  if (typeof occurrence.type === "number") {
    issueType = OCCURRENCE_TYPE_TO_ISSUE_TYPE[occurrence.type];
  } else {
    issueType = occurrence.issueType || occurrence.type;
  }

  const evidenceData = occurrence.evidenceData;

  // Process evidence data based on known performance issue types
  if (evidenceData) {
    switch (issueType) {
      case KNOWN_PERFORMANCE_ISSUE_TYPES.N_PLUS_ONE_DB_QUERIES:
      case KNOWN_PERFORMANCE_ISSUE_TYPES.N_PLUS_ONE_API_CALLS:
      case KNOWN_PERFORMANCE_ISSUE_TYPES.M_N_PLUS_ONE_DB_QUERIES: {
        const result = formatN1QueryEvidence(
          evidenceData,
          spansData,
          options?.performanceTrace,
        );
        if (result) parts.push(result);
        break;
      }

      case KNOWN_PERFORMANCE_ISSUE_TYPES.SLOW_DB_QUERY: {
        const result = formatSlowDbQueryEvidence(evidenceData, spansData);
        if (result) parts.push(result);
        break;
      }

      default:
        // We don't implement formatters for all performance issue types.
        // Many lower-priority issues (consecutive queries, asset issues, file I/O)
        // work fine with just the generic evidenceDisplay fields below.
        // Only high-value, complex issues like N+1 queries need custom formatting.
        if (issueType) {
          console.warn(
            `[formatPerformanceIssueOutput] No custom formatter for issue type: ${issueType}`,
          );
        }
      // Fall through to show generic evidence display below
    }
  }

  // Show transaction name if available for any performance issue (generic field)
  if (evidenceData?.transactionName) {
    parts.push("**Transaction:**");
    parts.push(`${evidenceData.transactionName}`);
    parts.push("");
  }

  // Always show evidence display if available (this is generic and doesn't require type knowledge)
  if (occurrence.evidenceDisplay?.length > 0) {
    for (const display of occurrence.evidenceDisplay) {
      if (display.important) {
        parts.push(`**${display.name}:**`);
        parts.push(`${display.value}`);
        parts.push("");
      }
    }
  }

  return parts.length > 0 ? `${parts.join("\n")}\n` : "";
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function formatPrimitive(value: unknown): string | undefined {
  return isPrimitive(value) ? String(value) : undefined;
}

/**
 * Extracts the Snuba query from metric alert evidence data.
 */
function getMetricAlertSnubaQuery(
  evidenceData: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const dataSources = evidenceData.data_sources;
  if (!Array.isArray(dataSources)) {
    return undefined;
  }

  for (const dataSource of dataSources) {
    if (!isPlainObject(dataSource)) {
      continue;
    }
    const queryObj = dataSource.query_obj;
    if (!isPlainObject(queryObj)) {
      continue;
    }
    const snubaQuery = queryObj.snuba_query;
    if (isPlainObject(snubaQuery)) {
      return snubaQuery;
    }
  }

  return undefined;
}

function formatMetricAlertCondition(
  condition: Record<string, unknown>,
): string | undefined {
  const comparison = condition.comparison;
  const formattedComparison = formatPrimitive(comparison);
  if (formattedComparison == null) {
    return undefined;
  }

  const type = condition.type;
  const typeLabel = (() => {
    if (type === 0 || type === "0" || type === "gt" || type === "gte") {
      return type === "gte" ? "at or above" : "above";
    }
    if (type === 1 || type === "1" || type === "lt" || type === "lte") {
      return type === "lte" ? "at or below" : "below";
    }
    if (type != null) {
      return String(type);
    }
    return undefined;
  })();

  if (typeLabel && !/^\d+$/.test(typeLabel)) {
    return `${typeLabel} ${formattedComparison}`;
  }

  return formattedComparison;
}

function formatMetricAlertValue(value: unknown): string | undefined {
  const formattedValue = formatPrimitive(value);
  if (formattedValue) {
    return formattedValue;
  }

  if (isPlainObject(value)) {
    return formatPrimitive(value.value);
  }

  return undefined;
}

function formatMetricAlertDetails(
  evidenceData: Record<string, unknown>,
): string {
  const parts: string[] = ["### Metric Alert Details", ""];

  const snubaQuery = getMetricAlertSnubaQuery(evidenceData);
  if (snubaQuery) {
    if (snubaQuery.dataset != null) {
      parts.push(`**Dataset**: ${String(snubaQuery.dataset)}`);
    }
    if (snubaQuery.aggregate != null) {
      parts.push(`**Aggregate**: ${String(snubaQuery.aggregate)}`);
    }
    if (snubaQuery.query != null && String(snubaQuery.query).length > 0) {
      parts.push(`**Query**: \`${String(snubaQuery.query)}\``);
    }
    if (snubaQuery.time_window != null) {
      parts.push(`**Interval**: ${String(snubaQuery.time_window)} second(s)`);
    }
    if (snubaQuery.environment != null) {
      parts.push(`**Environment**: ${String(snubaQuery.environment)}`);
    }
    parts.push("");
  }

  const formattedValue = formatMetricAlertValue(evidenceData.value);
  if (formattedValue) {
    parts.push(`**Evaluated Value**: ${formattedValue}`);
  }

  const conditions = evidenceData.conditions;
  if (Array.isArray(conditions)) {
    const formattedConditions = conditions
      .filter(isPlainObject)
      .map(formatMetricAlertCondition)
      .filter((condition): condition is string => condition != null);
    if (formattedConditions.length > 0) {
      parts.push(`**Threshold**: ${formattedConditions.join(", ")}`);
    }
  }

  if (evidenceData.alert_id != null) {
    parts.push(`**Alert Rule ID**: ${String(evidenceData.alert_id)}`);
  }

  parts.push("");
  return `${parts.join("\n")}\n`;
}

/**
 * Formats generic event output (performance regressions, metric-based issues).
 * Generic events don't have traditional error entries, but have occurrence data
 * with evidenceDisplay showing regression details, metric changes, etc.
 */
function formatGenericEventOutput(event: Event): string {
  const parts: string[] = [];

  // Only generic events have occurrence data
  if (event.type !== "generic") {
    return "";
  }

  // Type assertion after guard - we know it's a GenericEvent
  const genericEvent = event as GenericEvent;
  const occurrence = genericEvent.occurrence;
  if (!occurrence) {
    return "";
  }

  const evidenceData = occurrence.evidenceData;
  if (occurrence.type === 8001 && evidenceData) {
    return formatMetricAlertDetails(evidenceData);
  }

  // Add a section header for performance regression details
  if (evidenceData) {
    parts.push("### Performance Regression Details");
    parts.push("");
  }

  // Show evidence display items (regression details, metric changes, etc.)
  if (occurrence.evidenceDisplay && occurrence.evidenceDisplay.length > 0) {
    for (const display of occurrence.evidenceDisplay) {
      if (display.important) {
        parts.push(`**${display.name}:**`);
        parts.push(`${display.value}`);
        parts.push("");
      }
    }
  }

  return parts.length > 0 ? `${parts.join("\n")}\n` : "";
}

function formatTags(tags: z.infer<typeof EventSchema>["tags"]) {
  if (!tags || tags.length === 0) {
    return "";
  }
  return `### Tags\n\n${tags
    .map((tag) => `**${tag.key}**: ${tag.value}`)
    .join("\n")}\n\n`;
}

function formatEventUser(user: z.infer<typeof EventSchema>["user"]) {
  if (!user || Object.keys(user).length === 0) {
    return "";
  }

  const userFields = [
    ["id", user.id],
    ["email", user.email],
    ["username", user.username],
    ["ip", user.ip ?? user.ip_address],
    ["display_name", user.display_name ?? user.name],
  ].filter(([, value]) => typeof value === "string" && value.length > 0);

  const userSummary = userFields
    .map(([key, value]) => `${key}:${value}`)
    .join(", ");
  const geoSummary = formatUserGeoSummary(user.geo);

  if (!userSummary && !geoSummary) {
    return "";
  }

  let output = "### User\n\n";
  if (userSummary) {
    output += `**user**: ${userSummary}\n`;
  }
  if (geoSummary) {
    output += `**user.geo**: ${geoSummary}\n`;
  }

  return `${output}\n`;
}

function formatContext(context: z.infer<typeof EventSchema>["context"]) {
  if (!context || Object.keys(context).length === 0) {
    return "";
  }
  return `### Extra Data\n\nAdditional data attached to this event.\n\n${Object.entries(
    context,
  )
    .map(([key, value]) => {
      return `**${key}**: ${JSON.stringify(value, undefined, 2)}`;
    })
    .join("\n")}\n\n`;
}

function formatContexts(contexts: z.infer<typeof EventSchema>["contexts"]) {
  if (!contexts || Object.keys(contexts).length === 0) {
    return "";
  }
  return `### Additional Context\n\nThese are additional context provided by the user when they're instrumenting their application.\n\n${Object.entries(
    contexts,
  )
    .map(
      ([name, data]) =>
        `**${name}**\n${Object.entries(data)
          .filter(([key, _]) => key !== "type")
          .map(([key, value]) => {
            return `${key}: ${JSON.stringify(value, undefined, 2)}`;
          })
          .join("\n")}`,
    )
    .join("\n\n")}\n\n`;
}

/**
 * Formats a brief Seer analysis summary for inclusion in issue details.
 * Shows current status and high-level insights, prompting to use analyze_issue_with_seer for full details.
 *
 * @param autofixState - The autofix state containing Seer analysis data
 * @returns Formatted markdown string with Seer summary, or empty string if no analysis exists
 */
function formatSeerSummary(autofixState: AutofixRunState | undefined): string {
  if (!autofixState || !autofixState.autofix) {
    return "";
  }

  const { autofix } = autofixState;
  const parts: string[] = [];

  parts.push("## Seer Analysis");
  parts.push("");

  // Show status first
  if (!isTerminalStatus(autofix.status)) {
    parts.push(`**Status:** ${getStatusDisplayName(autofix.status)}`);
    parts.push("");
  }

  // Prefer the shared formatter's analysis for the body when the endpoint provides it, but
  // keep the status handling around it: a run that failed or needs input must say so either
  // way. Seer content is LLM-generated, so wrap it in the untrusted-data boundary.
  if (autofixState.formatted?.content) {
    parts.push(wrapSeerContent(autofixState.formatted.content, autofix.run_id));
  } else {
    // Summarize from the run's artifacts: the solution if available, otherwise
    // the root cause if it has been identified.
    const { rootCause, solution } = getAutofixArtifactSummaries(autofix);
    if (solution) {
      parts.push("**Summary:**");
      parts.push(solution);
    } else if (rootCause) {
      parts.push("**Root Cause Identified:**");
      parts.push(rootCause);
    } else if (!isTerminalStatus(autofix.status)) {
      parts.push("Analysis has started but no results yet.");
    }
  }

  if (autofix.status === "error") {
    parts.push("");
    parts.push("**Status:** Analysis failed.");
  } else if (autofix.status === "awaiting_user_input") {
    parts.push("");
    parts.push("**Status:** Analysis paused - additional information needed.");
  }

  return `${parts.join("\n")}\n\n`;
}

/** Projects the suspect commit consistently for structured and markdown issue details. */
export function getSuspectCommit(committers: CommitterList | undefined) {
  // The endpoint currently returns the issue's latest suspect commit, grouped by author.
  const committer = committers?.[0];
  const commit = committer?.commits[0];
  if (!commit) {
    return null;
  }
  return {
    id: String(commit.id),
    message: commit.message,
    author: committer.author?.name ?? committer.author?.email,
    suspectCommitType: commit.suspectCommitType,
  };
}

/**
 * Formats a Sentry issue with its latest event into comprehensive markdown output.
 * Includes issue metadata, event details, and usage instructions.
 *
 * @param params - Object containing organization slug, issue, event, and API service
 * @returns Formatted markdown string with complete issue information
 */
export function formatIssueOutput({
  organizationSlug,
  issue,
  event,
  apiService,
  autofixState,
  performanceTrace,
  externalIssues,
  relatedReplayIds,
  aiConversations,
  codeLocation,
  committers,
  experimentalMode,
  availableToolNames,
  directToolNames,
}: {
  organizationSlug: string;
  issue: Issue;
  event: Event;
  apiService: SentryApiService;
  autofixState?: AutofixRunState;
  performanceTrace?: Trace;
  externalIssues?: ExternalIssueList;
  relatedReplayIds?: string[];
  aiConversations?: AIConversationReference[];
  codeLocation?: CodeLocation;
  committers?: CommitterList;
  experimentalMode?: boolean;
  availableToolNames?: ReadonlySet<string>;
  directToolNames?: ReadonlySet<string>;
}) {
  let output = `# Issue ${issue.shortId} in **${organizationSlug}**\n\n`;

  const isPerformanceIssue = isPerformanceIssueType(issue);

  if (isPerformanceIssue && issue.metadata) {
    // For performance issues, use metadata for better context
    const issueTitle = issue.metadata.title || issue.title;
    output += `**Description**: ${issueTitle}\n`;

    if (issue.metadata.location) {
      output += `**Location**: ${issue.metadata.location}\n`;
    }
    if (issue.metadata.value) {
      output += `**Query Pattern**: \`${issue.metadata.value}\`\n`;
    }
  } else {
    // For regular errors and other issues
    output += `**Description**: ${issue.title}\n`;
    if (issue.culprit) {
      output += `**Culprit**: ${issue.culprit}\n`;
    }
  }

  if (issue.firstSeen) {
    output += `**First Seen**: ${new Date(issue.firstSeen).toISOString()}\n`;
  }
  if (issue.lastSeen) {
    output += `**Last Seen**: ${new Date(issue.lastSeen).toISOString()}\n`;
  }
  output += `**Occurrences**: ${issue.count}\n`;
  output += `**Users Impacted**: ${issue.userCount}\n`;
  output += `**Status**: ${issue.status}\n`;

  // Add substatus if present (e.g., "regressed" for performance regressions)
  if (issue.substatus) {
    output += `**Substatus**: ${issue.substatus}\n`;
  }

  // Add assignee information if assigned
  if (issue.assignedTo) {
    if (typeof issue.assignedTo === "string") {
      output += `**Assigned To**: ${issue.assignedTo}\n`;
    } else {
      const assignee = issue.assignedTo;
      const type = assignee.type === "team" ? "Team" : "User";
      output += `**Assigned To**: ${assignee.name} (${type})\n`;
    }
  }

  // Add issue type and category for performance/metric issues
  if (issue.issueType) {
    output += `**Issue Type**: ${issue.issueType}\n`;
  }
  if (issue.issueCategory) {
    output += `**Issue Category**: ${issue.issueCategory}\n`;
  }

  // Add Seer actionability score if available
  if (issue.seerFixabilityScore != null) {
    output += `**Seer Actionability**: ${getSeerActionabilityLabel(issue.seerFixabilityScore)}\n`;
  }

  output += `**Platform**: ${issue.platform}\n`;
  output += `**Project**: ${issue.project.name}\n`;
  output += `**URL**: ${apiService.getIssueUrl(organizationSlug, issue.shortId)}\n`;
  output += "\n";

  if (codeLocation) {
    output += formatCodeLocation(codeLocation);
  }

  const suspectCommit = getSuspectCommit(committers);
  if (suspectCommit) {
    output += "## Suspect Commit\n\n";
    output += `**SHA**: \`${suspectCommit.id}\`\n`;
    if (suspectCommit.message) {
      output += `**Message**: ${suspectCommit.message}\n`;
    }
    if (suspectCommit.author) {
      output += `**Author**: ${suspectCommit.author}\n`;
    }
    if (suspectCommit.suspectCommitType) {
      output += `**Source**: ${suspectCommit.suspectCommitType}\n`;
    }
    output += "\n";
  }

  output += "## Event Details\n\n";

  // Check if this is an unsupported event type
  // Event type union is: ErrorEvent | DefaultEvent | TransactionEvent | GenericEvent | CspEvent
  // But in practice we may have other types returned as UnknownEvent
  const eventType = event.type;
  const isUnsupportedType =
    eventType !== "error" &&
    eventType !== "default" &&
    eventType !== "transaction" &&
    eventType !== "generic" &&
    eventType !== "csp";

  if (isUnsupportedType) {
    // Log to Sentry for tracking new/unknown event types
    const sentryEventId = logIssue(
      `Unsupported event type encountered: ${String(eventType)}`,
      {
        contexts: {
          event: {
            event_id: event.id,
            event_type: eventType,
            issue_id: issue.id,
            issue_short_id: issue.shortId,
            organization_slug: organizationSlug,
            project_slug: issue.project.slug,
          },
        },
      },
    );

    output += `⚠️  **Warning**: Unsupported event type "${String(eventType)}"\n\n`;
    output += "This event type is not yet fully supported by the MCP server. ";
    output += "Only basic issue information is shown above.\n\n";
    output +=
      "**Please report this**: Open a GitHub issue at https://github.com/getsentry/sentry-mcp/issues/new ";
    output += `and include Event ID **${event.id}**`;
    if (sentryEventId) {
      output += ` and Sentry Event ID **${sentryEventId}**`;
    }
    output += " to help us add support for this event type.\n";

    if (aiConversations && aiConversations.length > 0) {
      output += "\n## Response Notes\n\n";
      output += formatAIConversationResponseNote({
        aiConversations,
        organizationSlug,
        experimentalMode: experimentalMode ?? false,
        availableToolNames,
        directToolNames,
      });
    }

    // For unsupported event types, return early without trying to render event details
    return output;
  }

  output += `**Event ID**: ${event.id}\n`;
  output += `**Type**: ${event.type}\n`;
  const isSharedFormatterType = usesSharedFormatterBody(event);
  if (isSharedFormatterType) {
    const typedEvent = event as
      | z.infer<typeof ErrorEventSchema>
      | z.infer<typeof DefaultEventSchema>
      | z.infer<typeof GenericEventSchema>
      | any; // CSP events don't have a schema yet
    if (typedEvent.dateCreated) {
      output += `**Occurred At**: ${new Date(typedEvent.dateCreated).toISOString()}\n`;
    }
  }
  if (event.message) {
    output += `**Message**:\n${event.message}\n`;
  }
  output += "\n";
  // only a markdown body belongs in this output; a json body is for structuredContent, and
  // pasting it here would put a serialized object in the middle of the prose
  if (
    isSharedFormatterType &&
    event.formatted?.format === "markdown" &&
    event.formatted.content
  ) {
    // the shared formatter body doesn't include the replay note — add it here to match formatEventOutput
    output += formatIssueReplayOutput({
      apiService,
      organizationSlug,
      event,
      relatedReplayIds,
      experimentalMode: experimentalMode ?? false,
      availableToolNames,
      directToolNames,
    });
    const formattedContent = event.formatted.content;
    output += formattedContent.endsWith("\n")
      ? formattedContent
      : `${formattedContent}\n`;
  } else {
    output += formatEventOutput(event, {
      performanceTrace,
      replaySummary: {
        apiService,
        organizationSlug,
        relatedReplayIds,
        experimentalMode: experimentalMode ?? false,
        availableToolNames,
        directToolNames,
      },
    });
  }

  // Add Seer context if available
  if (autofixState) {
    output += formatSeerSummary(autofixState);
  }

  // Add external issue links if available
  if (externalIssues && externalIssues.length > 0) {
    output += "## External Issue Links\n\n";
    for (const extIssue of externalIssues) {
      output += `- **${extIssue.displayName}** (${extIssue.serviceType}): ${extIssue.webUrl}\n`;
    }
    output += "\n";
  }

  const traceId =
    typeof event.contexts?.trace?.trace_id === "string" &&
    event.contexts.trace.trace_id.length > 0
      ? event.contexts.trace.trace_id
      : undefined;

  output += "## Response Notes\n\n";
  const commitIssueReference = /^\d+$/.test(issue.shortId)
    ? apiService.getIssueUrl(organizationSlug, issue.shortId)
    : issue.shortId;
  output += `- Commit message issue reference: \`Fixes ${commitIssueReference}\` automatically closes the issue when the commit is merged.\n`;
  output +=
    "- The stacktrace includes first-party application code and third-party code. First-party frames are usually the best starting point for triage.\n";
  if (aiConversations && aiConversations.length > 0) {
    output += formatAIConversationResponseNote({
      aiConversations,
      organizationSlug,
      experimentalMode: experimentalMode ?? false,
      availableToolNames,
      directToolNames,
    });
  }
  const issueEventSearchInstruction = formatToolCallInstruction({
    toolName: "search_issue_events",
    arguments: {
      organizationSlug,
      issueId: issue.shortId,
      query: "your query",
    },
    experimentalMode: experimentalMode ?? false,
    availableToolNames,
    directToolNames,
    fallbackInstruction: "Issue event search is not available in this session",
  });
  output += `- Issue event search: ${issueEventSearchInstruction}\n`;
  const hasMultipleThreads = event.entries?.some((entry) => {
    if (entry.type !== "threads") {
      return false;
    }
    const threadsData = parseThreadsEntryData(entry.data);
    return Boolean(threadsData?.values && threadsData.values.length > 1);
  });
  if (hasMultipleThreads) {
    const stacktraceInstruction = formatToolCallInstruction({
      toolName: "get_event_stacktrace",
      arguments: {
        organizationSlug,
        issueId: issue.shortId,
        eventId: event.id,
        thread: "thread name or numeric thread ID",
      },
      experimentalMode: experimentalMode ?? false,
      availableToolNames,
      directToolNames,
      fallbackInstruction: "",
      purpose:
        "to fetch a full thread stacktrace by numeric Thread ID or exact thread Name. Omit `thread` to use Sentry's default selected thread",
    });
    if (stacktraceInstruction) {
      output += `- Thread stacktrace lookup: ${stacktraceInstruction}\n`;
    }
  }
  if (traceId) {
    const traceDetailsInstruction = formatToolCallInstruction({
      toolName: "get_sentry_resource",
      arguments: {
        resourceType: "trace",
        organizationSlug,
        resourceId: traceId,
      },
      experimentalMode: experimentalMode ?? false,
      availableToolNames,
      directToolNames,
      fallbackInstruction:
        "Full distributed trace lookup is not available in this session",
    });
    const spanSearchInstruction = formatToolCallInstruction({
      toolName: "search_traces",
      arguments: {
        organizationSlug,
        query: `trace:${traceId}`,
      },
      experimentalMode: experimentalMode ?? false,
      availableToolNames,
      directToolNames,
      fallbackInstruction:
        "Related span search is not available in this session",
    });
    const logSearchInstruction = formatToolCallInstruction({
      toolName: "search_logs",
      arguments: {
        organizationSlug,
        query: `trace:${traceId}`,
      },
      experimentalMode: experimentalMode ?? false,
      availableToolNames,
      directToolNames,
      fallbackInstruction:
        "Related log search is not available in this session",
    });
    output += `- Full distributed trace and span tree: ${traceDetailsInstruction}\n`;
    output += `- Related span search: ${spanSearchInstruction}\n`;
    output += `- Related log search: ${logSearchInstruction}\n`;
  }
  if (experimentalMode) {
    const breadcrumbsInstruction = formatToolCallInstruction({
      toolName: "get_issue_breadcrumbs",
      arguments: {
        issueUrl: apiService.getIssueUrl(organizationSlug, issue.shortId),
      },
      experimentalMode,
      availableToolNames,
      directToolNames,
      fallbackInstruction:
        "Issue breadcrumbs are not available in this session",
    });
    output += `- Breadcrumb trail leading up to this error: ${breadcrumbsInstruction}\n`;
  }
  return output;
}

function formatAIConversationResponseNote({
  aiConversations,
  organizationSlug,
  experimentalMode,
  availableToolNames,
  directToolNames,
}: {
  aiConversations: AIConversationReference[];
  organizationSlug: string;
  experimentalMode: boolean;
  availableToolNames?: ReadonlySet<string>;
  directToolNames?: ReadonlySet<string>;
}): string {
  const instructions = formatAIConversationActionInstructions({
    organizationSlug,
    aiConversations,
    experimentalMode,
    availableToolNames,
    directToolNames,
  });

  if (aiConversations.length === 1) {
    const [conversation] = aiConversations;
    const spanSuffix = conversation.spanId
      ? ` Matching span: \`${conversation.spanId}\`.`
      : "";
    return `- Agent conversation found in this trace: \`${conversation.conversationId}\`.${spanSuffix}\n${instructions.map((instruction) => `- ${instruction}`).join("\n")}\n`;
  }

  const conversationIds = aiConversations
    .map((conversation) => `\`${conversation.conversationId}\``)
    .join(", ");
  return `- Multiple agent conversations were found in this trace: ${conversationIds}.\n${instructions.map((instruction) => `- ${instruction}`).join("\n")}\n`;
}

const MAX_DISPLAY_REPLAYS = 5;

function formatIssueReplayOutput({
  apiService,
  organizationSlug,
  event,
  relatedReplayIds,
  experimentalMode,
  availableToolNames,
  directToolNames,
}: {
  apiService: SentryApiService;
  organizationSlug: string;
  event: Event;
  relatedReplayIds?: string[];
  experimentalMode: boolean;
  availableToolNames?: ReadonlySet<string>;
  directToolNames?: ReadonlySet<string>;
}): string {
  const attachedReplayId = getReplayIdFromEvent(event);
  const normalizedRelatedReplayIds = dedupeReplayIds(relatedReplayIds ?? []);
  const additionalRelatedReplayIds = normalizedRelatedReplayIds.filter(
    (replayId) => replayId !== attachedReplayId,
  );

  if (!attachedReplayId && normalizedRelatedReplayIds.length === 0) {
    return "";
  }

  const lines: string[] = ["## Session Replay", ""];

  if (attachedReplayId) {
    lines.push(
      `**Attached Replay**: ${apiService.getReplayUrl(organizationSlug, attachedReplayId)}`,
    );
  }

  if (normalizedRelatedReplayIds.length > 0) {
    lines.push(
      `**Related Replay Count**: ${normalizedRelatedReplayIds.length}`,
    );
  }

  if (additionalRelatedReplayIds.length > 0) {
    const displayedReplayIds = additionalRelatedReplayIds.slice(
      0,
      MAX_DISPLAY_REPLAYS,
    );

    lines.push("");
    lines.push(
      attachedReplayId ? "### Other Related Replays" : "### Related Replays",
    );
    lines.push("");

    for (const replayId of displayedReplayIds) {
      lines.push(`- ${apiService.getReplayUrl(organizationSlug, replayId)}`);
    }

    const remainingReplayCount =
      additionalRelatedReplayIds.length - displayedReplayIds.length;
    if (remainingReplayCount > 0) {
      lines.push(
        `- ... and ${remainingReplayCount} more replay${remainingReplayCount === 1 ? "" : "s"}`,
      );
    }
  }

  const exampleReplayId =
    attachedReplayId ?? normalizedRelatedReplayIds.at(0) ?? null;
  if (exampleReplayId) {
    const replayDetailsInstruction = formatToolCallInstruction({
      toolName: "get_replay_details",
      arguments: {
        organizationSlug,
        replayId: exampleReplayId,
      },
      experimentalMode,
      availableToolNames,
      directToolNames,
      fallbackInstruction:
        "Replay detail lookup is not available in this session",
      purpose: "to inspect a replay in detail",
    });
    lines.push("");
    lines.push(`${replayDetailsInstruction}.`);
  }

  return `${lines.join("\n")}\n\n`;
}

export function getReplayIdFromEvent(event: Event): string | null {
  const replayContext = event.contexts?.replay as
    | Record<string, unknown>
    | undefined;
  const replayContextId =
    typeof replayContext?.replay_id === "string"
      ? replayContext.replay_id
      : null;
  const replayTagId =
    event.tags?.find((tag) => tag.key === "replayId" || tag.key === "replay.id")
      ?.value ?? null;

  return normalizeReplayId(replayContextId ?? replayTagId);
}

export function dedupeReplayIds(replayIds: string[]): string[] {
  const normalizedReplayIds: string[] = [];
  const seenReplayIds = new Set<string>();

  for (const replayId of replayIds) {
    const normalizedReplayId = normalizeReplayId(replayId);
    if (!normalizedReplayId || seenReplayIds.has(normalizedReplayId)) {
      continue;
    }
    seenReplayIds.add(normalizedReplayId);
    normalizedReplayIds.push(normalizedReplayId);
  }

  return normalizedReplayIds;
}

function normalizeReplayId(replayId: string | null | undefined): string | null {
  if (typeof replayId !== "string") {
    return null;
  }

  const trimmedReplayId = replayId.trim();
  if (!trimmedReplayId) {
    return null;
  }

  return trimmedReplayId.replace(/-/g, "");
}

function stripReplayMetadata(event: Event): Event {
  const tags = event.tags?.filter(
    (tag) => tag.key !== "replay.id" && tag.key !== "replayId",
  );
  const replayContext = event.contexts?.replay;

  if (!replayContext) {
    return { ...event, tags };
  }

  const nextReplayContext = Object.fromEntries(
    Object.entries(replayContext).filter(([key]) => key !== "replay_id"),
  );
  const nonTypeReplayKeys = Object.keys(nextReplayContext).filter(
    (key) => key !== "type",
  );
  const contexts =
    nonTypeReplayKeys.length === 0
      ? Object.fromEntries(
          Object.entries(event.contexts ?? {}).filter(
            ([key]) => key !== "replay",
          ),
        )
      : {
          ...event.contexts,
          replay: { ...nextReplayContext, type: replayContext.type },
        };

  return {
    ...event,
    tags,
    contexts,
  };
}
