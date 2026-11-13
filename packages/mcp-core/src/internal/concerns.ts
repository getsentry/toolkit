import { inlineCode } from "@sentry/toolkit-core/markdown";
import { z } from "zod";
import type { Event, SourceMapDebug } from "../api-client/types";
import { diagnoseSourceMaps } from "./source-map-diagnosis";

/**
 * Concerns are problems with the project's Sentry setup, such as missing
 * source maps, that are optional to fix but would make future issues easier to
 * debug. Detectors read the event and the checks already fetched for it in
 * `ConcernContext`, such as Sentry's source map debug result. When the problem
 * also changes how to read this event, the concern carries a one-line `caveat`
 * that renders next to the affected data.
 *
 * To add one, write a detector that returns a `Concern` or null and add it to
 * `DETECTORS`. `buildConcerns` orders them by priority and keeps the first
 * `MAX_CONCERNS`.
 */
export const concernSchema = z.object({
  code: z
    .string()
    .describe("Stable identifier of the problem, such as js_source_maps."),
  title: z.string(),
  message: z.string().describe("What is wrong and how to fix it."),
  docsUrl: z.string(),
  errorTypes: z
    .array(z.string())
    .describe("The Sentry event processing error types behind it."),
  files: z
    .array(z.string())
    .describe("Affected files, capped; fileCount says how many there are."),
  fileCount: z.number(),
  diagnosis: z
    .array(
      z.object({
        problem: z.string(),
        fix: z.string(),
        files: z.array(z.string()),
      }),
    )
    .describe(
      "Cause and fix for the affected files, from a Sentry check of this event. Empty when no check ran.",
    ),
  caveat: z
    .string()
    .nullable()
    .describe("How the problem affects reading this event, when it does."),
});

export type Concern = z.output<typeof concernSchema>;

const MAX_CONCERNS = 3;
const MAX_FILES = 3;

interface PrioritizedConcern {
  /** Lower comes first. */
  priority: number;
  concern: Concern;
}

/** Optional checks fetched for the event; a detector works without them. */
export interface ConcernContext {
  sourceMapDebug?: SourceMapDebug;
}

type Detector = (
  event: Event,
  context: ConcernContext,
) => PrioritizedConcern | null;

const JS_SOURCE_MAPS_DOCS_URL =
  "https://docs.sentry.io/platforms/javascript/sourcemaps/";
const JS_SOURCE_MAPS_TROUBLESHOOTING_URL =
  "https://docs.sentry.io/platforms/javascript/sourcemaps/troubleshooting_js/";

const UPLOAD_FIX =
  "Upload source maps for this release from the same build that was deployed.";

/**
 * The JavaScript processing error types in getsentry/sentry
 * `src/sentry/models/eventerror.py`, with what each one means for the user.
 * Order sets which problem is listed first. Sentry's actionable-items endpoint
 * hides `js_no_source` and `js_invalid_sourcemap_location`; we keep them
 * because they are the most common reason a stacktrace stays minified.
 */
const JS_SOURCE_MAP_ERRORS: ReadonlyMap<
  string,
  { problem: string; fix: string }
> = new Map([
  [
    "js_no_source",
    {
      problem: "the source file or its source map was not found",
      fix: UPLOAD_FIX,
    },
  ],
  [
    "js_invalid_sourcemap_location",
    {
      problem: "the source map does not match the minified file",
      fix: UPLOAD_FIX,
    },
  ],
  [
    "js_invalid_source",
    {
      problem: "the source map is invalid or could not be parsed",
      fix: "Regenerate the source map and upload it again.",
    },
  ],
  [
    "js_missing_sources_content",
    {
      problem: "the source map does not include the original source",
      fix: "Include sourcesContent in the source map, or upload the original source files.",
    },
  ],
  [
    "js_scraping_disabled",
    {
      problem:
        "source fetching is disabled for the project and no source maps were uploaded",
      fix: `${UPLOAD_FIX} Or enable JavaScript source fetching in the project settings.`,
    },
  ],
  [
    "js_invalid_source_encoding",
    {
      problem: "the source file is not encoded properly",
      fix: "Serve or upload the source files as UTF-8.",
    },
  ],
  [
    "js_invalid_content",
    {
      problem: "the source file is not JavaScript",
      fix: UPLOAD_FIX,
    },
  ],
  [
    "js_no_column",
    {
      problem: "the stacktrace has no column numbers to map",
      fix: "Make sure the runtime reports column numbers in stack traces.",
    },
  ],
  [
    "js_too_many_sources",
    {
      problem: "the limit of remote source requests was reached",
      fix: UPLOAD_FIX,
    },
  ],
  // deprecated by Sentry, but older events still carry them
  [
    "js_generic_fetch_error",
    { problem: "the source file could not be fetched", fix: UPLOAD_FIX },
  ],
  [
    "js_invalid_http_code",
    {
      problem: "fetching the source file returned an HTTP error",
      fix: UPLOAD_FIX,
    },
  ],
  [
    "js_too_large",
    { problem: "the source file is too large to fetch", fix: UPLOAD_FIX },
  ],
  [
    "js_fetch_timeout",
    { problem: "fetching the source file timed out", fix: UPLOAD_FIX },
  ],
]);

function getErrorFile(data: Record<string, unknown> | null | undefined) {
  // most JS processing errors name the file in `url`; sources content and
  // location errors name it in `source`
  const file = data?.url ?? data?.source;
  return typeof file === "string" && file.length > 0 ? file : null;
}

/** Whether Sentry reported a JavaScript source map failure for the event. */
export function hasJsSourceMapErrors(event: Event): boolean {
  return (event.errors ?? []).some(({ type }) =>
    JS_SOURCE_MAP_ERRORS.has(type),
  );
}

function detectJsSourceMapFailure(
  event: Event,
  { sourceMapDebug }: ConcernContext,
): PrioritizedConcern | null {
  const errorTypes = new Set<string>();
  // each affected file with the error types reported for it
  const files = new Map<string, Set<string>>();
  for (const error of event.errors ?? []) {
    if (!JS_SOURCE_MAP_ERRORS.has(error.type)) {
      continue;
    }
    errorTypes.add(error.type);
    const file = getErrorFile(error.data);
    if (file) {
      files.set(file, (files.get(file) ?? new Set()).add(error.type));
    }
  }
  if (errorTypes.size === 0) {
    return null;
  }

  const matched = [...JS_SOURCE_MAP_ERRORS].filter(([type]) =>
    errorTypes.has(type),
  );
  const problems = matched.map(([, detail]) => detail.problem).join("; ");
  const listed = new Map([...files].slice(0, MAX_FILES));
  const listedFiles = [...listed.keys()];
  const diagnosis = sourceMapDebug
    ? diagnoseSourceMaps({ event, debug: sourceMapDebug, files: listed })
    : [];
  // a diagnosis names the exact fix for its files; the error types' fix
  // covers the rest, and events whose errors name no file
  const fix =
    countDiagnosedFiles(diagnosis) === files.size && files.size > 0
      ? ""
      : ` Fix: ${[...new Set(matched.map(([, detail]) => detail.fix))].join(" ")}`;

  return {
    priority: 0,
    concern: {
      code: "js_source_maps",
      title: "Fix JavaScript source maps",
      message: `Sentry could not apply source maps to this event: ${problems}.${fix} Troubleshooting: ${JS_SOURCE_MAPS_TROUBLESHOOTING_URL}`,
      docsUrl: JS_SOURCE_MAPS_DOCS_URL,
      errorTypes: matched.map(([type]) => type),
      files: listedFiles,
      fileCount: files.size,
      diagnosis,
      caveat:
        "Source maps were not applied to this event; frames may point to minified code. See Concerns Identified.",
    },
  };
}

function countDiagnosedFiles(diagnosis: Concern["diagnosis"]): number {
  return diagnosis.reduce((count, { files }) => count + files.length, 0);
}

const DETECTORS: readonly Detector[] = [detectJsSourceMapFailure];

/** The concerns an event points to, most important first. */
export function buildConcerns(
  event: Event,
  context: ConcernContext = {},
): Concern[] {
  return DETECTORS.flatMap((detect) => {
    const result = detect(event, context);
    return result ? [result] : [];
  })
    .sort((a, b) => a.priority - b.priority)
    .slice(0, MAX_CONCERNS)
    .map((result) => result.concern);
}

/** One warning line per caveat, to render before the data they affect. */
export function formatConcernCaveats(concerns: Concern[]): string {
  const caveats = concerns.flatMap(({ caveat }) =>
    caveat ? [`⚠️ ${caveat}\n\n`] : [],
  );
  return caveats.join("");
}

/** The `## Concerns Identified` markdown section, or an empty string. */
export function formatConcernsSection(concerns: Concern[]): string {
  if (concerns.length === 0) {
    return "";
  }
  let output = "## Concerns Identified\n\n";
  output +=
    "Optional fixes that would make future issues easier to debug. They are not needed to investigate this issue.\n\n";
  for (const concern of concerns) {
    // messages are built from constants, and the diagnosis quotes upstream
    // values with inlineCode, so neither needs escaping here
    output += `- **${concern.title}**: ${concern.message}\n`;
    for (const { problem, fix, files } of concern.diagnosis) {
      output += `  - ${files.map(inlineCode).join(", ")}: ${problem}. Fix: ${fix}\n`;
    }
    if (
      concern.files.length > 0 &&
      countDiagnosedFiles(concern.diagnosis) < concern.fileCount
    ) {
      const more =
        concern.fileCount > concern.files.length
          ? ` (and ${concern.fileCount - concern.files.length} more)`
          : "";
      output += `  - Affected files: ${concern.files.map(inlineCode).join(", ")}${more}\n`;
    }
    output += `  - Docs: ${concern.docsUrl}\n`;
  }
  return `${output}\n`;
}
