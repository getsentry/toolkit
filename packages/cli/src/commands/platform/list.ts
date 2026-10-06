/**
 * sentry platform list
 *
 * List all valid Sentry platform identifiers. Purely local/static data —
 * no API access required. Exists so `sentry project create`'s missing/invalid
 * platform error can point users somewhere to see the full list, rather than
 * just the curated "Common platforms" subset shown inline in that error.
 *
 * Usage:
 *   sentry platform list                 → list all valid platforms
 *   sentry platforms                     → shortcut for the above
 *   sentry platform list --search python → filter by substring
 */

import type { SentryContext } from "../../context.js";
import { buildCommand } from "../../lib/command.js";
import { OutputError } from "../../lib/errors.js";
import { muted } from "../../lib/formatters/colors.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { renderPlatformGrid } from "../../lib/platform-grid.js";
import { VALID_PLATFORMS } from "../../lib/platforms.js";

type PlatformsFlags = {
  readonly search?: string;
};

/** Human renderer: grid of matching platforms, or a "no matches" message. */
function formatPlatformsHuman(list: readonly string[]): string {
  if (list.length === 0) {
    return muted("No platforms match that search.");
  }
  return `${renderPlatformGrid(list)}\n${list.length} platform${list.length === 1 ? "" : "s"}`;
}

export const listCommand = buildCommand({
  auth: false,
  docs: {
    brief: "List all valid Sentry platform identifiers",
    fullDescription:
      "List every valid Sentry platform identifier — the full set behind " +
      "`sentry project create <name>:<platform>`. Use --search to filter.\n\n" +
      "Examples:\n" +
      "  sentry platform list                 List all valid platforms\n" +
      "  sentry platform list --search python  Filter by substring\n" +
      "  sentry platform list --json           Machine-readable output",
  },
  output: {
    human: formatPlatformsHuman,
  },
  parameters: {
    flags: {
      search: {
        kind: "parsed",
        parse: String,
        brief: "Filter platforms by substring",
        optional: true,
      },
    },
    aliases: { q: "search" },
  },
  // biome-ignore lint/suspicious/useAwait: Stricli requires AsyncGenerator but this is synchronous (in-memory data)
  async *func(this: SentryContext, flags: PlatformsFlags) {
    if (!flags.search) {
      return yield new CommandOutput<readonly string[]>(VALID_PLATFORMS);
    }

    const term = flags.search.toLowerCase();
    const matches = VALID_PLATFORMS.filter((p) =>
      p.toLowerCase().includes(term)
    );
    if (matches.length === 0) {
      // No matches genuinely means nothing found for this search — exit non-zero,
      // same as `sentry schema --search` with zero results (grep-style semantics).
      throw new OutputError([] satisfies readonly string[]);
    }

    return yield new CommandOutput<readonly string[]>(matches);
  },
});
