/**
 * sentry release archive
 *
 * Archive a release by setting its status to "archived". Archived releases are
 * hidden from the default release list but retained; restore with
 * `sentry release restore`.
 */

import type { SentryContext } from "../../context.js";
import { updateRelease } from "../../lib/api-client.js";
import { buildCommand } from "../../lib/command.js";
import {
  colorTag,
  escapeMarkdownInline,
  mdKvTable,
  renderMarkdown,
  safeCodeSpan,
} from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { DRY_RUN_ALIASES, DRY_RUN_FLAG } from "../../lib/mutate-command.js";
import type { SentryRelease } from "../../types/index.js";
import { type ReleaseTarget, releaseParameter } from "./parse.js";

const USAGE_HINT = "sentry release archive [<org>/]<version>";

/**
 * Render the human-readable result of archiving a release.
 *
 * @param data - Either the dry-run preview object or the updated release.
 */
function formatReleaseArchived(data: Record<string, unknown>): string {
  if (data.dryRun) {
    return renderMarkdown(
      `Would archive release ${safeCodeSpan(String(data.version))} (dry run)`,
    );
  }
  const release = data as unknown as SentryRelease;
  const lines: string[] = [];
  lines.push(`## Release Archived: ${escapeMarkdownInline(release.version)}`);
  lines.push("");
  const kvRows: [string, string][] = [];
  kvRows.push(["Version", safeCodeSpan(release.version)]);
  kvRows.push(["Status", colorTag("muted", "Archived")]);
  lines.push(mdKvTable(kvRows));
  return renderMarkdown(lines.join("\n"));
}

export const archiveCommand = buildCommand({
  docs: {
    brief: "Archive a release",
    fullDescription:
      "Mark a release as archived. Archived releases are hidden from the " +
      "default `sentry release list` but are retained and can be restored " +
      "with `sentry release restore`.",
    examples: [
      {
        description:
          "Archive a release (hide it from the default list, but keep it)",
        command: "sentry release archive 1.0.0",
      },
      {
        description: "Archive a release in an explicit organization",
        command: "sentry release archive my-org/1.0.0",
      },
      {
        description: "Preview without archiving",
        command: "sentry release archive my-org/1.0.0 --dry-run",
      },
    ],
  },
  output: {
    human: formatReleaseArchived,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        releaseParameter(
          USAGE_HINT,
          "[<org>/]<version> - Release version to archive",
        ),
      ],
    },
    flags: {
      "dry-run": DRY_RUN_FLAG,
    },
    aliases: { ...DRY_RUN_ALIASES },
  },
  async *func(
    this: SentryContext,
    flags: {
      readonly "dry-run": boolean;
      readonly json: boolean;
      readonly fields?: string[];
    },
    target: ReleaseTarget,
  ) {
    const { version, org, detectedFrom } = await target.resolved;

    if (flags["dry-run"]) {
      yield new CommandOutput({ dryRun: true, version, org });
      return { hint: "Dry run — release was not archived." };
    }

    const release = await updateRelease(org, version, {
      status: "archived",
    });
    yield new CommandOutput(release);
    const hint = detectedFrom ? `Detected from ${detectedFrom}` : undefined;
    return { hint };
  },
});
