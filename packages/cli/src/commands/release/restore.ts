/**
 * sentry release restore
 *
 * Restore an archived release by setting its status back to "open", making it
 * visible in the default release list again.
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
import { resolveReleaseTarget } from "./parse.js";

const USAGE_HINT = "sentry release restore [<org>/]<version>";

/**
 * Render the human-readable result of restoring a release.
 *
 * @param data - Either the dry-run preview object or the updated release.
 */
function formatReleaseRestored(data: Record<string, unknown>): string {
  if (data.dryRun) {
    return renderMarkdown(
      `Would restore release ${safeCodeSpan(String(data.version))} (dry run)`
    );
  }
  const release = data as unknown as SentryRelease;
  const lines: string[] = [];
  lines.push(`## Release Restored: ${escapeMarkdownInline(release.version)}`);
  lines.push("");
  const kvRows: [string, string][] = [];
  kvRows.push(["Version", safeCodeSpan(release.version)]);
  kvRows.push(["Status", colorTag("green", "Open")]);
  lines.push(mdKvTable(kvRows));
  return renderMarkdown(lines.join("\n"));
}

export const restoreCommand = buildCommand({
  docs: {
    brief: "Restore an archived release",
    fullDescription:
      "Restore an archived release by setting its status back to open, " +
      "making it visible in the default `sentry release list` again.\n\n" +
      "Examples:\n" +
      "  sentry release restore 1.0.0\n" +
      "  sentry release restore my-org/1.0.0\n" +
      "  sentry release restore 1.0.0 --dry-run",
  },
  output: {
    human: formatReleaseRestored,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "org/version",
          brief: "[<org>/]<version> - Release version to restore",
          parse: String,
        },
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
    target: string
  ) {
    const { cwd } = this;

    const { version, org, detectedFrom } = await resolveReleaseTarget(
      target,
      USAGE_HINT,
      cwd
    );

    if (flags["dry-run"]) {
      yield new CommandOutput({ dryRun: true, version, org });
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
