/**
 * sentry org list
 *
 * List organizations the user has access to.
 */

import type { SentryContext } from "../../context.js";
import { listOrganizationsUncached } from "../../lib/api-client.js";
import { buildCommand } from "../../lib/command.js";
import { DEFAULT_SENTRY_HOST } from "../../lib/constants.js";
import { getAllOrgRegions } from "../../lib/db/regions.js";
import { escapeMarkdownCell } from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { type Column, writeTable } from "../../lib/formatters/table.js";
import {
  applyFreshFlag,
  buildListLimitFlag,
  FRESH_ALIASES,
  FRESH_FLAG,
} from "../../lib/list-command.js";
import { logger } from "../../lib/logger.js";
import { withProgress } from "../../lib/polling.js";
import type { SentryOrganization, Writer } from "../../types/index.js";

type ListFlags = {
  readonly limit: number;
  readonly json: boolean;
  readonly fresh: boolean;
  readonly fields?: string[];
};

/**
 * An organization enriched with an optional region display name.
 *
 * The `region` field is only present when the user's orgs span multiple
 * regions (e.g. both US and EU). It is included in JSON output as well,
 * providing region context to machine consumers.
 */
type OrgListEntry = SentryOrganization & { region?: string };

/**
 * Extract a human-readable region name from a region URL.
 * Strips the .sentry.io suffix and maps known regions to display names.
 *
 * @example "https://sentry.io" -> "US" (default)
 * @example "https://us.sentry.io" -> "US"
 * @example "https://de.sentry.io" -> "EU"
 * @example "https://east-1.us.sentry.io" -> "EAST-1.US"
 */
const log = logger.withTag("org.list");

function getRegionDisplayName(regionUrl: string): string {
  try {
    const url = new URL(regionUrl);
    const { hostname } = url;

    // Strip .sentry.io suffix to get the region identifier
    const suffix = `.${DEFAULT_SENTRY_HOST}`;
    let regionPart: string;
    if (hostname === DEFAULT_SENTRY_HOST) {
      regionPart = "sentry"; // sentry.io -> sentry (US default)
    } else if (hostname.endsWith(suffix)) {
      regionPart = hostname.slice(0, -suffix.length); // us.sentry.io -> us
    } else {
      regionPart = hostname; // Non-sentry domain, use as-is
    }

    const regionMap: Record<string, string> = {
      us: "US",
      de: "EU",
      sentry: "US", // sentry.io defaults to US
    };
    return regionMap[regionPart] ?? regionPart.toUpperCase();
  } catch (error) {
    log.debug(`Failed to parse region URL "${regionUrl}"`, error);
    return "?";
  }
}

/**
 * Format org list entries as a human-readable table.
 *
 * Includes a REGION column only when at least one entry has a region set
 * (indicating the user's orgs span multiple regions).
 */
function formatOrgListHuman(entries: OrgListEntry[]): string {
  if (entries.length === 0) {
    return "No organizations found.";
  }

  const showRegion = entries.some((e) => e.region !== undefined);

  type OrgRow = { slug: string; name: string; region?: string };
  const rows: OrgRow[] = entries.map((org) => ({
    slug: org.slug,
    name: org.name,
    region: showRegion ? (org.region ?? "") : undefined,
  }));

  const columns: Column<OrgRow>[] = [
    { header: "SLUG", value: (r) => r.slug },
    ...(showRegion
      ? [{ header: "REGION", value: (r: OrgRow) => r.region ?? "" }]
      : []),
    { header: "NAME", value: (r) => escapeMarkdownCell(r.name) },
  ];

  const parts: string[] = [];
  const buffer: Writer = { write: (s: string) => parts.push(s) };
  writeTable(buffer, rows, columns);

  return parts.join("").trimEnd();
}

export const listCommand = buildCommand({
  docs: {
    brief: "List organizations",
    fullDescription:
      "List organizations that you have access to.\n\n" +
      "Examples:\n" +
      "  sentry org list\n" +
      "  sentry org list --limit 10\n" +
      "  sentry org list --json\n\n" +
      "Alias: `sentry orgs` → `sentry org list`",
  },
  output: { human: formatOrgListHuman },
  parameters: {
    flags: {
      limit: buildListLimitFlag("organizations"),
      fresh: FRESH_FLAG,
    },
    // Only -n for --limit; no -c since org list has no --cursor flag
    aliases: { ...FRESH_ALIASES, n: "limit" },
  },
  async *func(this: SentryContext, flags: ListFlags) {
    applyFreshFlag(flags);

    const orgs = await withProgress(
      {
        message: `Fetching organizations (up to ${flags.limit})...`,
        json: flags.json,
      },
      () => listOrganizationsUncached()
    );
    const limitedOrgs = orgs.slice(0, flags.limit);

    // Check if user has orgs in multiple regions
    const orgRegions = getAllOrgRegions();
    const uniqueRegions = new Set(orgRegions.values());
    const showRegion = uniqueRegions.size > 1;

    const entries: OrgListEntry[] = limitedOrgs.map((org) => ({
      ...org,
      region: showRegion
        ? getRegionDisplayName(orgRegions.get(org.slug) ?? "")
        : undefined,
    }));

    const hints: string[] = [];
    if (orgs.length > flags.limit) {
      hints.push(`Showing ${flags.limit} of ${orgs.length} organizations`);
    }
    if (entries.length > 0) {
      hints.push("Tip: Use 'sentry org view <slug>' for details");
    }

    yield new CommandOutput(entries);
    return { hint: hints.join("\n") || undefined };
  },
});
