import { inlineCode } from "@sentry/toolkit-core/markdown";
import { ErrorEntrySchema } from "../api-client";
import type { Event, SourceMapDebug } from "../api-client/types";

/** Why one or more files missed their source maps, and how to fix it. */
export interface SourceMapFinding {
  problem: string;
  fix: string;
  files: string[];
}

type DebugFrame = SourceMapDebug["exceptions"][number]["frames"][number];

const INJECT_FIX =
  "Inject debug IDs into the build output with the Sentry bundler plugin or `sentry-cli sourcemaps inject`, deploy those files, and upload the same files with `sentry-cli sourcemaps upload`.";

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
 * first, then release artifacts, then fetching from the web.
 */
export function diagnoseSourceMaps({
  event,
  debug,
  files,
}: {
  event: Event;
  debug: SourceMapDebug;
  files: string[];
}): SourceMapFinding[] {
  const frames = getDebugFramesByPath(event, debug);
  const findings = new Map<string, SourceMapFinding>();
  for (const file of files) {
    const frame = frames.get(file);
    if (!frame) {
      continue;
    }
    const { problem, fix } = diagnoseFrame(event, debug, frame);
    const key = `${problem}\n${fix}`;
    const finding = findings.get(key);
    if (finding) {
      finding.files.push(file);
    } else {
      findings.set(key, { problem, fix, files: [file] });
    }
  }
  return [...findings.values()];
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
): { problem: string; fix: string } {
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
    return {
      problem: `Sentry found the source file and its source map ${foundBy}, but could not apply the map to this file`,
      fix: "Make sure the map comes from the deployed file: generate source maps in the last build step that changes the files, then upload them again.",
    };
  }

  if (debug.sdk_debug_id_support === "full") {
    if (!debugId.debug_id) {
      return {
        problem: debug.has_uploaded_some_artifact_with_a_debug_id
          ? "The deployed file has no debug ID"
          : "The deployed file has no debug ID, and the project has no uploads with debug IDs",
        fix: INJECT_FIX,
      };
    }
    const missing = [
      debugId.uploaded_source_file_with_correct_debug_id ? null : "source file",
      debugId.uploaded_source_map_with_correct_debug_id ? null : "source map",
    ]
      .filter(Boolean)
      .join(" and ");
    return {
      problem: `No ${missing} with debug ID ${inlineCode(debugId.debug_id)} was uploaded`,
      fix: "Upload the build output that was deployed, after injecting debug IDs, with the Sentry bundler plugin or `sentry-cli sourcemaps upload`.",
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
        problem: `Nothing was uploaded for release ${releaseName}`,
        fix: `Upload the build output for release ${releaseName}.${upgrade}`,
      };
    }
    for (const [result, kind] of [
      [release.source_file_lookup_result, "source file"],
      [release.source_map_lookup_result, "source map"],
    ] as const) {
      if (result === "wrong-dist") {
        return {
          problem: `The uploaded ${kind} has a different dist than the event (${inlineCode(debug.dist ?? "none")})`,
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
        problem: `No file uploaded for release ${releaseName} has the deployed file's name`,
        fix: `Upload it as ${names || "its URL"}, for example by setting the URL prefix in the upload.${upgrade}`,
      };
    }
    return release.source_map_reference
      ? {
          problem: `No uploaded source map matches the file's reference ${inlineCode(release.source_map_reference)}`,
          fix: `Upload the source map under that name for release ${releaseName}.${upgrade}`,
        }
      : {
          problem: "The deployed file has no `sourceMappingURL` comment",
          fix: `Keep the \`sourceMappingURL\` comment in the build output, or use debug IDs.${upgrade}`,
        };
  }

  const fetched = [scraping?.source_file, scraping?.source_map].find(
    (attempt) => attempt?.status === "failure",
  );
  if (fetched) {
    const reason =
      SCRAPING_FAILURES.get(fetched.reason ?? "") ?? "the reason is unknown";
    return {
      problem: `Sentry could not fetch ${inlineCode(fetched.url ?? "the file")} from the web: ${reason}`,
      fix: `Upload source maps so Sentry does not need to fetch them.${upgrade}`,
    };
  }

  return {
    problem:
      "The event has no release, so Sentry cannot look up uploaded files",
    fix: `Set \`release\` in \`Sentry.init\` and upload source maps for that release.${upgrade}`,
  };
}
