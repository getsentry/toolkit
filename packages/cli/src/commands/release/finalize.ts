/**
 * sentry release finalize
 *
 * Finalize a release by setting its dateReleased to now.
 */

import { description, looseObject, optional, pipe, string } from "valibot";
import type { SentryContext } from "../../context.js";
import { updateRelease } from "../../lib/api-client.js";
import { buildCommand } from "../../lib/command.js";
import { parseText, parseUrl } from "../../lib/completion-target.js";
import {
  colorTag,
  escapeMarkdownInline,
  mdKvTable,
  renderMarkdown,
  safeCodeSpan,
} from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { DRY_RUN_ALIASES, DRY_RUN_FLAG } from "../../lib/mutate-command.js";
import {
  ReleaseUpdateOutputSchema,
  type SentryRelease,
} from "../../types/index.js";
import { type ReleaseTarget, releaseParameter } from "./parse.js";

const USAGE_HINT = "sentry release finalize [<org>/]<version>";

function formatReleaseFinalized(data: Record<string, unknown>): string {
  if (data.dryRun) {
    return renderMarkdown(
      `Would finalize release ${safeCodeSpan(String(data.version))} (dry run)`,
    );
  }
  const release = data as unknown as SentryRelease;
  const lines: string[] = [];
  lines.push(`## Release Finalized: ${escapeMarkdownInline(release.version)}`);
  lines.push("");
  const kvRows: [string, string][] = [];
  kvRows.push(["Version", safeCodeSpan(release.version)]);
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
        command: "sentry release finalize 1.0.0",
      },
      {
        description: "Finalize a release in an explicit organization",
        command: "sentry release finalize my-org/1.0.0",
      },
      {
        description: "Set a custom release timestamp",
        command:
          "sentry release finalize 1.0.0 --released 2025-01-01T00:00:00Z",
      },
      {
        description: "Preview without finalizing",
        command: "sentry release finalize 1.0.0 --dry-run",
      },
    ],
  },
  output: {
    human: formatReleaseFinalized,
    schema: looseObject({
      ...ReleaseUpdateOutputSchema.entries,
      released: optional(
        pipe(string(), description("Release date to set (--dry-run)")),
      ),
    }),
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        releaseParameter(
          USAGE_HINT,
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
