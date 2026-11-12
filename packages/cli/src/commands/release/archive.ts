/**
 * sentry release archive
 *
 * Archive a release by setting its status to "archived". Archived releases are
 * hidden from the default release list but retained; restore with
 * `sentry release restore`.
 */

import { inlineCode, text } from "@sentry/toolkit-core/markdown";
import type { SentryContext } from "../../context.js";
import { updateRelease } from "../../lib/api-client.js";
import { buildCommand } from "../../lib/command.js";
import {
  colorTag,
  mdKvTable,
  renderMarkdown,
} from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { DRY_RUN_ALIASES, DRY_RUN_FLAG } from "../../lib/mutate-command.js";
import type { ReleaseUpdateOutput } from "../../types/index.js";
import { type ReleaseTarget, releaseParameter } from "./parse.js";
import { ReleaseUpdateOutputSchema } from "../../generated/output-schemas/release.js";
import { sentry } from "../../lib/app-identity.js";

const usageHint = () => sentry`release archive [<org>/]<version>`;

/**
 * Render the human-readable result of archiving a release.
 *
 * @param release - Either the dry-run preview or the updated release.
 */
function formatReleaseArchived(release: ReleaseUpdateOutput): string {
  if (release.dryRun) {
    return renderMarkdown(
      `Would archive release ${inlineCode(release.version)} (dry run)`,
    );
  }
  const lines: string[] = [];
  lines.push(`## Release Archived: ${text(release.version)}`);
  lines.push("");
  const kvRows: [string, string][] = [];
  kvRows.push(["Version", inlineCode(release.version)]);
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
        run: "release archive 1.0.0",
      },
      {
        description: "Archive a release in an explicit organization",
        run: "release archive my-org/1.0.0",
      },
      {
        description: "Preview without archiving",
        run: "release archive my-org/1.0.0 --dry-run",
      },
    ],
  },
  output: {
    human: formatReleaseArchived,
    schema: ReleaseUpdateOutputSchema,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        releaseParameter(
          usageHint,
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
      yield new CommandOutput({
        dryRun: true,
        version,
        org,
      });
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
