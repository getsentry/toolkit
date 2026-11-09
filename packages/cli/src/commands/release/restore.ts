/**
 * sentry release restore
 *
 * Restore an archived release by setting its status back to "open", making it
 * visible in the default release list again.
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

const usageHint = () => sentry`release restore [<org>/]<version>`;

/**
 * Render the human-readable result of restoring a release.
 *
 * @param release - Either the dry-run preview or the updated release.
 */
function formatReleaseRestored(release: ReleaseUpdateOutput): string {
  if (release.dryRun) {
    return renderMarkdown(
      `Would restore release ${inlineCode(release.version)} (dry run)`,
    );
  }
  const lines: string[] = [];
  lines.push(`## Release Restored: ${text(release.version)}`);
  lines.push("");
  const kvRows: [string, string][] = [];
  kvRows.push(["Version", inlineCode(release.version)]);
  kvRows.push(["Status", colorTag("green", "Open")]);
  lines.push(mdKvTable(kvRows));
  return renderMarkdown(lines.join("\n"));
}

export const restoreCommand = buildCommand({
  docs: {
    brief: "Restore an archived release",
    fullDescription:
      "Restore an archived release by setting its status back to open, " +
      "making it visible in the default `sentry release list` again.",
    examples: [
      {
        description: "Restore a previously archived release",
        run: "release restore 1.0.0",
      },
      {
        description: "Restore a release in an explicit organization",
        run: "release restore my-org/1.0.0",
      },
      {
        description: "Preview without restoring",
        run: "release restore 1.0.0 --dry-run",
      },
    ],
  },
  output: {
    human: formatReleaseRestored,
    schema: ReleaseUpdateOutputSchema,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        releaseParameter(
          usageHint,
          "[<org>/]<version> - Release version to restore",
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
      return { hint: "Dry run — release was not restored." };
    }

    const release = await updateRelease(org, version, {
      status: "open",
    });
    yield new CommandOutput(release);
    const hint = detectedFrom ? `Detected from ${detectedFrom}` : undefined;
    return { hint };
  },
});
