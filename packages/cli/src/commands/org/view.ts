/**
 * sentry org view
 *
 * View detailed information about a Sentry organization.
 */

import type { SentryContext } from "../../context.js";
import { getOrganization } from "../../lib/api-client.js";
import { openInBrowser } from "../../lib/browser.js";
import { buildCommand } from "../../lib/command.js";
import { ContextError } from "../../lib/errors.js";
import { formatOrgDetails } from "../../lib/formatters/index.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import {
  applyFreshFlag,
  FRESH_ALIASES,
  FRESH_FLAG,
} from "../../lib/list-command.js";
import { resolveOrg } from "../../lib/resolve-target.js";
import { buildOrgUrl } from "../../lib/sentry-urls.js";

type ViewFlags = {
  readonly json: boolean;
  readonly web: boolean;
  readonly fresh: boolean;
  readonly fields?: string[];
};

export const viewCommand = buildCommand({
  docs: {
    brief: "View details of an organization",
    fullDescription:
      "View detailed information about a Sentry organization.\n\n" +
      "The organization is resolved from:\n" +
      "  1. Positional argument <org-slug>\n" +
      "  2. Config defaults\n" +
      "  3. SENTRY_DSN environment variable or source code detection",
  },
  output: { human: formatOrgDetails },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "org",
          brief: "Organization slug (optional if auto-detected)",
          parse: String,
          optional: true,
        },
      ],
    },
    flags: {
      web: {
        kind: "boolean",
        brief: "Open in browser",
        default: false,
      },
      fresh: FRESH_FLAG,
    },
    aliases: { ...FRESH_ALIASES, w: "web" },
  },
  async *func(this: SentryContext, flags: ViewFlags, orgSlug?: string) {
    applyFreshFlag(flags);
    const { cwd } = this;

    const resolved = await resolveOrg({ org: orgSlug, cwd });

    if (!resolved) {
      throw new ContextError("Organization", "sentry org view <org-slug>");
    }

    if (flags.web) {
      await openInBrowser(buildOrgUrl(resolved.org), "organization");
      return;
    }

    const org = await getOrganization(resolved.org);

    const hint = resolved.detectedFrom
      ? `Detected from ${resolved.detectedFrom}`
      : undefined;
    yield new CommandOutput(org);
    return { hint };
  },
});
