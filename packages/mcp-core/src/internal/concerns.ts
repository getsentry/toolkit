import { inlineCode } from "@sentry/toolkit-core/markdown";
import { z } from "zod";
import type { Event } from "../api-client/types";

/**
 * Concerns are problems with the project's Sentry setup, such as missing
 * source maps, that are optional to fix but would make future issues easier to
 * debug. Each comes from data already on the event; none needs an extra API
 * call. When the problem also changes how to read this event, the concern
 * carries a one-line `caveat` that renders next to the affected data.
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

type Detector = (event: Event) => PrioritizedConcern | null;

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

function detectJsSourceMapFailure(event: Event): PrioritizedConcern | null {
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
    concern: {
      code: "js_source_maps",
      title: "Fix JavaScript source maps",
      message: `Sentry could not apply source maps to this event: ${problems}. Fix: ${fixes} Troubleshooting: ${JS_SOURCE_MAPS_TROUBLESHOOTING_URL}`,
      docsUrl: JS_SOURCE_MAPS_DOCS_URL,
      errorTypes: matched.map(([type]) => type),
      files: [...files].slice(0, MAX_FILES),
      fileCount: files.size,
      caveat:
        "Source maps were not applied to this event; frames may point to minified code. See Concerns Identified.",
    },
  };
}

const DETECTORS: readonly Detector[] = [detectJsSourceMapFailure];

/** The concerns an event points to, most important first. */
export function buildConcerns(event: Event): Concern[] {
  return DETECTORS.flatMap((detect) => {
    const result = detect(event);
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
    // the message is built from constants, so it needs no escaping
    output += `- **${concern.title}**: ${concern.message}\n`;
    if (concern.files.length > 0) {
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
