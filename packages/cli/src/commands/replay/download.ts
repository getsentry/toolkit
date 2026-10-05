/**
 * sentry replay download
 *
 * Download a Session Replay recording as rrweb JSON: the flat event array
 * that rrweb-player and rrvideo consume.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { SentryContext } from "../../context.js";
import {
  getReplayRecordingSegments,
  resolveReplay,
} from "../../lib/api-client.js";
import { buildCommand } from "../../lib/command.js";
import { ApiError, ResolutionError } from "../../lib/errors.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import {
  formatReplayDownloadResult,
  type ReplayDownloadData,
} from "../../lib/formatters/replay.js";
import { validateHexId } from "../../lib/hex-id.js";
import {
  applyFreshFlag,
  FRESH_ALIASES,
  FRESH_FLAG,
} from "../../lib/list-command.js";
import { logger } from "../../lib/logger.js";
import {
  hasFullSnapshot,
  rrwebDurationMs,
  toRRWebEvents,
} from "../../lib/replay-rrweb.js";
import { resolveOrgOptionalFromArg } from "../../lib/resolve-target.js";
import type { ReplayDetails } from "../../types/index.js";
import { parsePositionalArgs, validateReplayProjectScope } from "./view.js";

type DownloadFlags = {
  readonly output?: string;
  readonly fresh: boolean;
};

const USAGE_HINT =
  "sentry replay download [<org>/<project>/]<replay-id> | <replay-url>";

const log = logger.withTag("replay.download");

export const downloadCommand = buildCommand({
  docs: {
    brief: "Download a Session Replay as rrweb JSON",
    fullDescription:
      "Download a Session Replay recording as rrweb JSON: a single flat, " +
      "time-ordered array of events that rrweb-player and rrvideo can play.\n\n" +
      "All recorded events are kept, including Sentry's custom events " +
      "(breadcrumbs, performance spans).\n\n" +
      "ID formats:\n" +
      "  <id>                     - auto-detect org from config or DSN\n" +
      "  <org>/<id>               - explicit organization\n" +
      "  <org>/<project>/<id>     - explicit org/project context\n" +
      "  <replay-url>             - parse org and replay ID from a Sentry URL\n\n" +
      "Examples:\n" +
      "  sentry replay download 346789a703f6454384f1de473b8b9fcc\n" +
      "  sentry replay download sentry/346789a703f6454384f1de473b8b9fcc\n" +
      "  sentry replay download sentry/346789a703f6454384f1de473b8b9fcc --output ./replay.json\n" +
      "  sentry replay download https://sentry.io/organizations/sentry/explore/replays/346789a703f6454384f1de473b8b9fcc/",
  },
  output: {
    human: formatReplayDownloadResult,
  },
  parameters: {
    positional: {
      kind: "array",
      parameter: {
        placeholder: "replay-id-or-url",
        brief: "[<org>/<project>] <replay-id or trace-id> or <replay-url>",
        parse: String,
      },
    },
    flags: {
      output: {
        kind: "parsed",
        parse: String,
        brief:
          "Output path (default: <replay-id>.rrweb.json in the current directory)",
        optional: true,
      },
      fresh: FRESH_FLAG,
    },
    aliases: { ...FRESH_ALIASES, o: "output" },
  },
  async *func(this: SentryContext, flags: DownloadFlags, ...args: string[]) {
    applyFreshFlag(flags);
    const { cwd } = this;

    const parsedArgs = parsePositionalArgs(args, USAGE_HINT);
    if (parsedArgs.warning) {
      log.warn(parsedArgs.warning);
    }

    const replayId = validateHexId(parsedArgs.replayId, "replay ID");
    const resolved = await resolveOrgOptionalFromArg(
      parsedArgs.targetArg,
      cwd,
      "replay download"
    );

    let replay: ReplayDetails;
    try {
      replay = await resolveReplay(resolved.org, replayId, {
        projectSlugs: resolved.project ? [resolved.project] : undefined,
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        throw new ResolutionError(
          `Replay '${replayId}'`,
          "not found",
          `sentry replay download ${resolved.org}/${replayId}`,
          [
            "Check that you are querying the right organization",
            "The replay may be past your retention window",
          ]
        );
      }
      throw error;
    }

    await validateReplayProjectScope({
      org: resolved.org,
      project: resolved.project,
      expectedProjectId: resolved.projectData?.id,
      replayId,
      replay,
      command: "download",
    });

    if (replay.is_archived || !replay.project_id) {
      throw noRecordingError(resolved.org, replay.id);
    }

    // No expectedSegments hint: follow the cursor to the end so a stale
    // count_segments can't cut the download short.
    const segments = await getReplayRecordingSegments(
      resolved.org,
      String(replay.project_id),
      replay.id
    );
    const events = toRRWebEvents(segments);
    if (events.length === 0) {
      throw noRecordingError(resolved.org, replay.id);
    }
    if (!hasFullSnapshot(events)) {
      log.warn(
        "This recording has no full DOM snapshot (e.g. a mobile replay), so rrweb players cannot render it."
      );
    }

    const output = resolve(cwd, flags.output ?? `${replay.id}.rrweb.json`);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(events));

    yield new CommandOutput<ReplayDownloadData>({
      org: resolved.org,
      replayId: replay.id,
      output,
      segmentCount: segments.length,
      eventCount: events.length,
      durationMs: rrwebDurationMs(events),
    });
    return { hint: `Downloaded replay ${replay.id} to ${output}` };
  },
});

/** The segments endpoint answers 200 [] for archived or expired recordings. */
function noRecordingError(org: string, replayId: string): ResolutionError {
  return new ResolutionError(
    `Replay '${replayId}'`,
    "has no recording to download",
    `sentry replay view ${org}/${replayId}`,
    ["The replay may be archived or past your retention window"]
  );
}
