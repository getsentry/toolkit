import { inlineCode } from "@sentry/toolkit-core/markdown";
import { ErrorEntrySchema } from "../api-client";
import type { Event, SourceMapDebug } from "../api-client/types";

/** Why one or more files missed their source maps, and how to fix it. */
export interface SourceMapFinding {
  /** A sentence that names the files, such as "`/a.js` has no debug ID". */
  problem: string;
  fix: string;
  files: string[];
}

/** The rest of a problem sentence after its files; `many` for several. */
type Predicate = (many: boolean) => string;

const has = (many: boolean) => (many ? "have" : "has");
const is = (many: boolean) => (many ? "are" : "is");

type DebugFrame = SourceMapDebug["exceptions"][number]["frames"][number];

const INJECT_FIX =
  "Inject debug IDs with the bundler plugin or `sentry-cli sourcemaps inject`, deploy, then upload those same files.";

/** What each failure reason of Sentry's fetch attempts means. */
const SCRAPING_FAILURES: ReadonlyMap<string, string> = new Map([
  ["not_found", "it was not found"],
  ["disabled", "source fetching is disabled for the project"],
  ["invalid_host", "the project does not allow its host"],
  ["permission_denied", "the server denied access"],
  ["timeout", "the request timed out"],
  ["download_error", "the download failed"],
]);

/**
 * Explains, from Sentry's source map debug check, why each affected file
 * missed its source map. Follows the order of Sentry's own debugger: debug IDs
 * first, then release artifacts, then fetching from the web. Files the check
 * cannot explain get no finding, so their error types' fix still applies.
 */
export function diagnoseSourceMaps({
  event,
  debug,
  files,
}: {
  event: Event;
  debug: SourceMapDebug;
  /** Each affected file with the processing error types reported for it. */
  files: ReadonlyMap<string, ReadonlySet<string>>;
}): SourceMapFinding[] {
  const frames = getDebugFramesByPath(event, debug);
  const findings = new Map<
    string,
    { predicate: Predicate; fix: string; files: string[] }
  >();
  for (const [file, errorTypes] of files) {
    const frame = frames.get(file);
    const diagnosis = frame && diagnoseFrame(event, debug, frame, errorTypes);
    if (!diagnosis) {
      continue;
    }
    const { predicate, fix } = diagnosis;
    const key = `${predicate(false)}\n${fix}`;
    const finding = findings.get(key);
    if (finding) {
      finding.files.push(file);
    } else {
      findings.set(key, { predicate, fix, files: [file] });
    }
  }
  return [...findings.values()].map(({ predicate, fix, files }) => ({
    problem: `${formatFileList(files)} ${predicate(files.length > 1)}`,
    fix,
    files,
  }));
}

/** Files as inline code: "`a`", "`a` and `b`", or "`a`, `b`, and `c`". */
export function formatFileList(files: string[], more = 0): string {
  const names = files.map(inlineCode);
  if (more > 0) {
    names.push(`${more} more`);
  }
  return names.length > 2
    ? `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`
    : names.join(" and ");
}

/**
 * Pairs each raw frame's path with its debug result. The endpoint returns one
 * entry per exception value and raw stacktrace frame, in event order.
 */
function getDebugFramesByPath(event: Event, debug: SourceMapDebug) {
  const frames = new Map<string, DebugFrame>();
  const values = event.entries.flatMap((entry) => {
    if (entry.type !== "exception") {
      return [];
    }
    const parsed = ErrorEntrySchema.safeParse(entry.data);
    if (!parsed.success) {
      return [];
    }
    return parsed.data.values ?? (parsed.data.value ? [parsed.data.value] : []);
  });
  values.forEach((value, exceptionIndex) => {
    const rawFrames = value?.rawStacktrace?.frames ?? [];
    rawFrames.forEach((rawFrame, frameIndex) => {
      const path = rawFrame.absPath;
      // the check can return fewer exceptions or frames than the event has
      const frame = debug.exceptions.at(exceptionIndex)?.frames.at(frameIndex);
      if (path && frame && !frames.has(path)) {
        frames.set(path, frame);
      }
    });
  });
  return frames;
}

function diagnoseFrame(
  event: Event,
  debug: SourceMapDebug,
  frame: DebugFrame,
  errorTypes: ReadonlySet<string>,
): { predicate: Predicate; fix: string } | null {
  const { debug_id_process: debugId, release_process: release } = frame;
  const scraping = frame.scraping_process;

  const foundBy =
    debugId.uploaded_source_file_with_correct_debug_id &&
    debugId.uploaded_source_map_with_correct_debug_id
      ? "by debug ID"
      : release?.source_file_lookup_result === "found" &&
          release.source_map_lookup_result === "found"
        ? `in release ${inlineCode(debug.release ?? "")}`
        : scraping?.source_file?.status === "success" &&
            scraping.source_map?.status === "success"
          ? "by fetching them"
          : null;
  if (foundBy) {
    // with both files found, only a location error means the map doesn't fit
    // the deployed file; other errors (missing sourcesContent, bad encoding)
    // keep the fix for their type
    if (!errorTypes.has("js_invalid_sourcemap_location")) {
      return null;
    }
    return {
      predicate: (many) =>
        `${many ? "don't match the source maps" : "doesn't match the source map"} Sentry found ${foundBy}`,
      fix: "Generate source maps in the last build step that changes the files, then upload them again.",
    };
  }

  if (debug.sdk_debug_id_support === "full") {
    if (!debugId.debug_id) {
      return {
        predicate: (many) =>
          debug.has_uploaded_some_artifact_with_a_debug_id
            ? `${has(many)} no debug ID`
            : `${has(many)} no debug ID, and the project has no debug ID uploads`,
        fix: INJECT_FIX,
      };
    }
    const missing = [
      debugId.uploaded_source_file_with_correct_debug_id ? null : "source file",
      debugId.uploaded_source_map_with_correct_debug_id ? null : "source map",
    ]
      .filter(Boolean)
      .join(" or ");
    const id = inlineCode(debugId.debug_id);
    return {
      predicate: (many) =>
        `${has(many)} debug ID ${id}, but no ${missing} with it was uploaded`,
      fix: "Upload the deployed build output after injecting debug IDs, with the bundler plugin or `sentry-cli sourcemaps upload`.",
    };
  }

  const upgrade =
    debug.sdk_debug_id_support === "needs-upgrade" &&
    debug.min_debug_id_sdk_version
      ? ` Or upgrade ${inlineCode(event.sdk?.name ?? "the SDK")} to ${debug.min_debug_id_sdk_version} or later and use debug IDs.`
      : "";

  if (debug.release && release) {
    const releaseName = inlineCode(debug.release);
    if (!debug.release_has_some_artifact) {
      return {
        predicate: (many) =>
          `${has(many)} no upload, since release ${releaseName} has none`,
        fix: `Upload the build output for release ${releaseName}.${upgrade}`,
      };
    }
    for (const [result, kind] of [
      [release.source_file_lookup_result, "source file"],
      [release.source_map_lookup_result, "source map"],
    ] as const) {
      if (result === "wrong-dist") {
        const dist = inlineCode(debug.dist ?? "none");
        return {
          predicate: (many) =>
            `${has(many)} an uploaded ${kind} with a different dist than the event (${dist})`,
          fix: `Upload with the same dist that the SDK sends.${upgrade}`,
        };
      }
    }
    if (release.source_file_lookup_result !== "found") {
      const names = release.matching_source_file_names
        .slice(0, 2)
        .map(inlineCode)
        .join(" or ");
      return {
        predicate: (many) =>
          `${has(many)} no upload under ${many ? "their names" : "its name"} in release ${releaseName}`,
        fix: `Upload it as ${names || "its URL"}, for example by setting the URL prefix in the upload.${upgrade}`,
      };
    }
    const reference = release.source_map_reference;
    return reference
      ? {
          predicate: (many) =>
            `${is(many)} missing ${many ? "their" : "its"} source map ${inlineCode(reference)}`,
          fix: `Upload the source map under that name for release ${releaseName}.${upgrade}`,
        }
      : {
          predicate: (many) => `${has(many)} no \`sourceMappingURL\` comment`,
          fix: `Keep the \`sourceMappingURL\` comment in the build output, or use debug IDs.${upgrade}`,
        };
  }

  const fetched = [scraping?.source_file, scraping?.source_map].find(
    (attempt) => attempt?.status === "failure",
  );
  if (fetched) {
    const reason =
      SCRAPING_FAILURES.get(fetched.reason ?? "") ?? "the reason is unknown";
    const url = inlineCode(fetched.url ?? "the file");
    return {
      predicate: (many) =>
        fetched === scraping?.source_file
          ? `couldn't be fetched from ${url}: ${reason}`
          : `${has(many)} a source map at ${url} that couldn't be fetched: ${reason}`,
      fix: `Upload source maps so Sentry does not need to fetch them.${upgrade}`,
    };
  }

  return {
    predicate: () =>
      "can't be matched to uploads because the event has no release",
    fix: `Set \`release\` in \`Sentry.init\` and upload source maps for that release.${upgrade}`,
  };
}
