/**
 * sentry release finalize
 *
 * Finalize a release by setting its dateReleased to now.
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

const USAGE_HINT = "sentry release finalize [<org>/]<version>";

function formatReleaseFinalized(data: Record<string, unknown>): string {
  if (data.dryRun) {
    return renderMarkdown(
      `Would finalize release ${safeCodeSpan(String(data.version))} (dry run)`
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
    fullDescription:
      "Mark a release as finalized by setting its release date.\n\n" +
      "Examples:\n" +
      "  sentry release finalize 1.0.0\n" +
      "  sentry release finalize my-org/1.0.0\n" +
      "  sentry release finalize 1.0.0 --released 2025-01-01T00:00:00Z\n" +
      "  sentry release finalize 1.0.0 --dry-run",
  },
  output: {
    human: formatReleaseFinalized,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "org/version",
          brief: "[<org>/]<version> - Release version to finalize",
          parse: String,
        },
      ],
    },
    flags: {
      released: {
        kind: "parsed",
        parse: String,
        brief: "Custom release timestamp (ISO 8601). Defaults to now.",
        optional: true,
      },
      url: {
        kind: "parsed",
        parse: String,
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
    target: string
  ) {
    const { cwd } = this;

    const { version, org, detectedFrom } = await resolveReleaseTarget(
      target,
      USAGE_HINT,
      cwd
    );

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
