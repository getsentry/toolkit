/**
 * sentry release view
 *
 * View details of a specific release, including per-project
 * health and adoption metrics when available.
 */

import type { SentryContext } from "../../context.js";
import { getRelease } from "../../lib/api-client.js";
import { buildCommand } from "../../lib/command.js";
import {
  colorTag,
  escapeMarkdownCell,
  escapeMarkdownInline,
  mdKvTable,
  mdTableHeader,
  renderMarkdown,
  safeCodeSpan,
} from "../../lib/formatters/markdown.js";
import { fmtCount, fmtPct } from "../../lib/formatters/numbers.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { formatRelativeTime } from "../../lib/formatters/time-utils.js";
import {
  applyFreshFlag,
  FRESH_ALIASES,
  FRESH_FLAG,
} from "../../lib/list-command.js";
import type { SentryRelease } from "../../types/index.js";
import { resolveReleaseTarget } from "./parse.js";

const USAGE_HINT = "sentry release view [<org>/]<version>";

/** Wrap a plain "—" in muted color for consistent table styling. */
function mutedIfDash(value: string): string {
  return value === "—" ? colorTag("muted", "—") : value;
}

/** Format a crash-free rate with color coding (green ≥ 99, yellow ≥ 95, red < 95). */
export function fmtCrashFree(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return colorTag("muted", "—");
  }
  const formatted = `${value.toFixed(1)}%`;
  if (value >= 99) {
    return colorTag("green", formatted);
  }
  if (value >= 95) {
    return colorTag("yellow", formatted);
  }
  return colorTag("red", formatted);
}

/**
 * Build a markdown table of per-project health data.
 *
 * Only includes projects that have health data. Returns empty string
 * if no project has data (so the section is skipped entirely).
 */
function formatProjectHealthTable(release: SentryRelease): string {
  const projects = release.projects?.filter((p) => p.healthData?.hasHealthData);
  if (!projects?.length) {
    return "";
  }

  const lines: string[] = [];
  lines.push("### Health by Project");
  lines.push("");

  // Table header: right-align numeric columns with trailing ":"
  lines.push(
    mdTableHeader([
      "PROJECT",
      "ADOPTION:",
      "CRASH-FREE USERS:",
      "CRASH-FREE SESSIONS:",
      "USERS (24h):",
      "SESSIONS (24h):",
    ])
  );

  for (const project of projects) {
    const h = project.healthData;
    const cells = [
      escapeMarkdownCell(project.slug),
      mutedIfDash(fmtPct(h?.adoption)),
      fmtCrashFree(h?.crashFreeUsers),
      fmtCrashFree(h?.crashFreeSessions),
      mutedIfDash(fmtCount(h?.totalUsers24h)),
      mutedIfDash(fmtCount(h?.totalSessions24h)),
    ];
    lines.push(`| ${cells.join(" | ")} |`);
  }

  return lines.join("\n");
}

function formatReleaseDetails(release: SentryRelease): string {
  const lines: string[] = [];

  lines.push(
    `## Release ${escapeMarkdownInline(release.shortVersion || release.version)}`
  );
  lines.push("");

  const kvRows: [string, string][] = [];
  kvRows.push(["Version", safeCodeSpan(release.version)]);
  if (release.shortVersion && release.shortVersion !== release.version) {
    kvRows.push(["Short Version", safeCodeSpan(release.shortVersion)]);
  }
  kvRows.push([
    "Status",
    release.dateReleased
      ? colorTag("green", "Finalized")
      : colorTag("yellow", "Unreleased"),
  ]);
  if (release.dateCreated) {
    kvRows.push(["Created", formatRelativeTime(release.dateCreated)]);
  }
  kvRows.push([
    "Released",
    release.dateReleased ? formatRelativeTime(release.dateReleased) : "—",
  ]);
  kvRows.push([
    "First Event",
    release.firstEvent ? formatRelativeTime(release.firstEvent) : "—",
  ]);
  kvRows.push([
    "Last Event",
    release.lastEvent ? formatRelativeTime(release.lastEvent) : "—",
  ]);
  kvRows.push(["Ref", release.ref || "—"]);
  kvRows.push(["Commits", String(release.commitCount ?? 0)]);
  kvRows.push(["Deploys", String(release.deployCount ?? 0)]);
  kvRows.push(["New Issues", String(release.newGroups ?? 0)]);

  if (release.projects?.length) {
    kvRows.push(["Projects", release.projects.map((p) => p.slug).join(", ")]);
  }

  if (release.lastDeploy) {
    kvRows.push([
      "Last Deploy",
      `${release.lastDeploy.environment} (${formatRelativeTime(release.lastDeploy.dateFinished)})`,
    ]);
  }

  lines.push(mdKvTable(kvRows));

  // Per-project health breakdown (only if any project has data)
  const healthTable = formatProjectHealthTable(release);
  if (healthTable) {
    lines.push("");
    lines.push(healthTable);
  }

  return renderMarkdown(lines.join("\n"));
}

export const viewCommand = buildCommand({
  docs: {
    brief: "View release details with health metrics",
    fullDescription:
      "Show detailed information about a Sentry release, including\n" +
      "per-project adoption and crash-free metrics.\n\n" +
      "Examples:\n" +
      "  sentry release view 1.0.0\n" +
      "  sentry release view my-org/1.0.0\n" +
      '  sentry release view "sentry-cli@0.24.0"\n' +
      "  sentry release view 1.0.0 --json",
  },
  output: {
    human: formatReleaseDetails,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "org/version",
          brief: "[<org>/]<version> - Release version to view",
          parse: String,
        },
      ],
    },
    flags: {
      fresh: FRESH_FLAG,
    },
    aliases: { ...FRESH_ALIASES },
  },
  async *func(
    this: SentryContext,
    flags: {
      readonly fresh: boolean;
      readonly json: boolean;
      readonly fields?: string[];
    },
    target: string
  ) {
    applyFreshFlag(flags);
    const { cwd } = this;

    const { version, org, detectedFrom } = await resolveReleaseTarget(
      target,
      USAGE_HINT,
      cwd
    );

    const release = await getRelease(org, version, {
      health: true,
      adoptionStages: true,
    });
    yield new CommandOutput(release);
    const hint = detectedFrom ? `Detected from ${detectedFrom}` : undefined;
    return { hint };
  },
});
