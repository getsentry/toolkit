import { inlineCode } from "@sentry/toolkit-core/markdown";
import { z } from "zod";
import type { Event } from "../api-client/types";

/**
 * Data quality hints warn that part of an event cannot be trusted as shown,
 * such as a stacktrace that still points at minified code, and say how to fix
 * it. Each hint comes from data already on the event; none needs an extra API
 * call.
 *
 * To add a hint, write a detector that returns a `DataQualityHint` or null and
 * add it to `DETECTORS`. `buildDataQualityHints` orders hints by priority and
 * keeps the first `MAX_DATA_QUALITY_HINTS`.
 */
export const dataQualityHintSchema = z.object({
  code: z
    .string()
    .describe("Stable identifier of the problem, such as js_source_maps."),
  title: z.string(),
  message: z
    .string()
    .describe("What went wrong, what it affects, and how to fix it."),
  docsUrl: z.string(),
  errorTypes: z
    .array(z.string())
    .describe("The Sentry event processing error types behind the hint."),
  files: z
    .array(z.string())
    .describe("Affected files, capped; fileCount says how many there are."),
  fileCount: z.number(),
});

export type DataQualityHint = z.output<typeof dataQualityHintSchema>;

const MAX_DATA_QUALITY_HINTS = 3;
const MAX_HINT_FILES = 3;

interface PrioritizedHint {
  /** Lower comes first. */
  priority: number;
  hint: DataQualityHint;
}

type Detector = (event: Event) => PrioritizedHint | null;

const JS_SOURCE_MAPS_DOCS_URL =
  "https://docs.sentry.io/platforms/javascript/sourcemaps/";
const JS_SOURCE_MAPS_TROUBLESHOOTING_URL =
  "https://docs.sentry.io/platforms/javascript/sourcemaps/troubleshooting_js/";

const UPLOAD_FIX =
  "Upload source maps for this release from the same build that was deployed.";

/**
 * The JavaScript processing error types in getsentry/sentry
 * `src/sentry/models/eventerror.py`, with what each one means for the user.
 * Order sets which problem is listed first.
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

function detectJsSourceMapFailure(event: Event): PrioritizedHint | null {
  const errorTypes = new Set<string>();
  const files = new Set<string>();
  for (const error of event.errors ?? []) {
    if (!JS_SOURCE_MAP_ERRORS.has(error.type)) {
      continue;
    }
    errorTypes.add(error.type);
    const file = getErrorFile(error.data);
    if (file) {
      files.add(file);
    }
  }
  if (errorTypes.size === 0) {
    return null;
  }

  const matched = [...JS_SOURCE_MAP_ERRORS].filter(([type]) =>
    errorTypes.has(type),
  );
  const problems = matched.map(([, detail]) => detail.problem).join("; ");
  const fixes = [...new Set(matched.map(([, detail]) => detail.fix))].join(" ");

  return {
    priority: 0,
    hint: {
      code: "js_source_maps",
      title: "Source maps not applied",
      message: [
        `Sentry could not apply source maps to this event: ${problems}.`,
        "File names, line numbers, and function names in the stacktrace and Code Location may point to minified or bundled code instead of the original source.",
        `Fix: ${fixes}`,
        `Troubleshooting: ${JS_SOURCE_MAPS_TROUBLESHOOTING_URL}`,
      ].join(" "),
      docsUrl: JS_SOURCE_MAPS_DOCS_URL,
      errorTypes: matched.map(([type]) => type),
      files: [...files].slice(0, MAX_HINT_FILES),
      fileCount: files.size,
    },
  };
}

const DETECTORS: readonly Detector[] = [detectJsSourceMapFailure];

/** The data quality problems on an event, most important first. */
export function buildDataQualityHints(event: Event): DataQualityHint[] {
  return DETECTORS.flatMap((detect) => {
    const result = detect(event);
    return result ? [result] : [];
  })
    .sort((a, b) => a.priority - b.priority)
    .slice(0, MAX_DATA_QUALITY_HINTS)
    .map((result) => result.hint);
}

/** The `## Data Quality` markdown section, or an empty string. */
export function formatDataQualitySection(hints: DataQualityHint[]): string {
  if (hints.length === 0) {
    return "";
  }
  let output = "## Data Quality\n\n";
  for (const hint of hints) {
    // the message is built from constants, so it needs no escaping
    output += `- **${hint.title}**: ${hint.message}\n`;
    if (hint.files.length > 0) {
      const more =
        hint.fileCount > hint.files.length
          ? ` (and ${hint.fileCount - hint.files.length} more)`
          : "";
      output += `  - Affected files: ${hint.files.map(inlineCode).join(", ")}${more}\n`;
    }
    output += `  - Docs: ${hint.docsUrl}\n`;
  }
  return `${output}\n`;
}
