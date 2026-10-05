/**
 * sentry auth whoami
 *
 * Display the currently authenticated identity. For user-scoped tokens (OAuth,
 * PAT), this fetches the user from `/auth/`. For org auth tokens (`sntrys_`),
 * it extracts the organization from the token's embedded claim.
 */

import type { SentryContext } from "../../context.js";
import { getCurrentUser } from "../../lib/api-client.js";
import { buildCommand } from "../../lib/command.js";
import { getAuthToken } from "../../lib/db/auth.js";
import { setUserInfo } from "../../lib/db/user.js";
import { ResolutionError } from "../../lib/errors.js";
import {
  formatOrgTokenIdentity,
  formatUserIdentity,
  type OrgTokenIdentity,
} from "../../lib/formatters/index.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import {
  applyFreshFlag,
  FRESH_ALIASES,
  FRESH_FLAG,
} from "../../lib/list-command.js";
import { logger } from "../../lib/logger.js";
import { parseSntrysClaim } from "../../lib/token-claims.js";
import { classifySentryToken } from "../../lib/token-type.js";

const log = logger.withTag("auth.whoami");

type WhoamiFlags = {
  readonly json: boolean;
  readonly fresh: boolean;
  readonly fields?: string[];
};

/**
 * Discriminate between user identity and org-token identity for the human
 * formatter. The `type` field is only present on org-token output.
 */
function formatWhoami(
  data: OrgTokenIdentity | Record<string, unknown>
): string {
  if ("type" in data && data.type === "org-auth-token") {
    return formatOrgTokenIdentity(data as OrgTokenIdentity);
  }
  return formatUserIdentity(data as Parameters<typeof formatUserIdentity>[0]);
}

export const whoamiCommand = buildCommand({
  docs: {
    brief: "Show the currently authenticated identity",
    fullDescription:
      "Display the identity behind the current authentication token.\n\n" +
      "For user-scoped tokens (OAuth, personal access tokens), this fetches " +
      "the user from the Sentry API. For organization auth tokens (`sntrys_`), " +
      "it shows which organization the token belongs to.",
  },
  output: {
    human: formatWhoami,
  },
  parameters: {
    flags: {
      fresh: FRESH_FLAG,
    },
    aliases: FRESH_ALIASES,
  },
  async *func(this: SentryContext, flags: WhoamiFlags) {
    applyFreshFlag(flags);

    const token = getAuthToken();
    if (token && classifySentryToken(token) === "org-auth-token") {
      const claim = parseSntrysClaim(token);
      if (!claim) {
        // Malformed sntrys_ token — claim parsing failed. Fall back to the
        // original error since we can't extract any useful info.
        throw new ResolutionError(
          "Organization auth tokens (sntrys_...)",
          "are not tied to a user — `whoami` needs a user-scoped credential",
          "sentry auth status",
          [
            "Use an OAuth token from `sentry auth login` or a personal access token",
            "Run `sentry org list` to list organizations this token can access",
          ]
        );
      }

      log.warn(
        "This is an organization auth token — not tied to a specific user."
      );

      const data: OrgTokenIdentity = {
        type: "org-auth-token",
        organization: claim.org,
        url: claim.url,
        regionUrl: claim.regionUrl,
      };
      yield new CommandOutput(data);
      return {
        hint: "Run `sentry auth login` for user-scoped authentication",
      };
    }

    const user = await getCurrentUser();

    // Keep cached user info up to date. Non-fatal: display must succeed even
    // if the DB write fails (read-only filesystem, corrupted database, etc.).
    try {
      setUserInfo({
        userId: user.id,
        email: user.email ?? undefined,
        username: user.username ?? undefined,
        name: user.name ?? undefined,
      });
    } catch (error) {
      log.debug("Failed to update cached user info", error);
    }

    return yield new CommandOutput(user);
  },
});
