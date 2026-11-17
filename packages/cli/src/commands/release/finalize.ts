/**
 * sentry release finalize
 *
 * Finalize a release by setting its dateReleased to now.
 */

import { inlineCode, text } from "@sentry/toolkit-core/markdown";
import type { SentryContext } from "../../context.js";
import { updateRelease } from "../../lib/api-client.js";
import { buildCommand } from "../../lib/command.js";
import { parseText, parseUrl } from "../../lib/completion-target.js";
import {
  colorTag,
  mdKvTable,
  renderMarkdown,
} from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { DRY_RUN_ALIASES, DRY_RUN_FLAG } from "../../lib/mutate-command.js";
import type { SentryRelease, WithOutputFields } from "../../types/index.js";
import { type ReleaseTarget, releaseParameter } from "./parse.js";
import { ReleaseFinalizeOutputSchema } from "../../generated/output-schemas/release.js";
import type { ReleaseFinalizeOutputFields } from "../../output-schemas/release.js";
import { sentry } from "../../lib/app-identity.js";

const usageHint = () => sentry`release finalize [<org>/]<version>`;

/** JSON output: the finalized release, or the `--dry-run` preview. */
type FinalizeOutput = WithOutputFields<
  SentryRelease,
  typeof ReleaseFinalizeOutputFields
>;

function formatReleaseFinalized(release: FinalizeOutput): string {
  if (release.dryRun) {
    return renderMarkdown(
      `Would finalize release ${inlineCode(release.version)} (dry run)`,
    );
  }
  const lines: string[] = [];
  lines.push(`## Release Finalized: ${text(release.version)}`);
  lines.push("");
  const kvRows: [string, string][] = [];
  kvRows.push(["Version", inlineCode(release.version)]);
  kvRows.push(["Status", colorTag("green", "Finalized")]);
  kvRows.push(["Released", release.dateReleased || "—"]);
  lines.push(mdKvTable(kvRows));
  return renderMarkdown(lines.join("\n"));
}

export const finalizeCommand = buildCommand({
  docs: {
    brief: "Finalize a release",
    fullDescription: "Mark a release as finalized by setting its release date.",
    examples: [
      {
        description: "Finalize a release",
        run: "release finalize 1.0.0",
      },
      {
        description: "Finalize a release in an explicit organization",
        run: "release finalize my-org/1.0.0",
      },
      {
        description: "Set a custom release timestamp",
        run: "release finalize 1.0.0 --released 2025-01-01T00:00:00Z",
      },
      {
        description: "Preview without finalizing",
        run: "release finalize 1.0.0 --dry-run",
      },
    ],
  },
  output: {
    human: formatReleaseFinalized,
    schema: ReleaseFinalizeOutputSchema,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        releaseParameter(
          usageHint,
          "[<org>/]<version> - Release version to finalize",
        ),
      ],
    },
    flags: {
      released: {
        kind: "parsed",
        parse: parseText,
        brief: "Custom release timestamp (ISO 8601). Defaults to now.",
        optional: true,
      },
      url: {
        kind: "parsed",
        parse: parseUrl,
        brief: "URL for the release",
        optional: true,
      },
      "dry-run": DRY_RUN_FLAG,
    },
    aliases: { ...DRY_RUN_ALIASES },
  },
  async *func(
    this: SentryContext,
    flags: {
      readonly released?: string;
      readonly url?: string;
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
        released: flags.released || new Date().toISOString(),
      });
      return { hint: "Dry run — release was not finalized." };
    }

    const body: Record<string, string> = {
      dateReleased: flags.released || new Date().toISOString(),
    };
    if (flags.url) {
      body.url = flags.url;
    }
    const release = await updateRelease(org, version, body);
    yield new CommandOutput(release);
    const hint = detectedFrom ? `Detected from ${detectedFrom}` : undefined;
    return { hint };
  },
});
