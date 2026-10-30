/**
 * sentry token delete
 *
 * Revoke an org auth token by ID.
 *
 * Uses `buildDeleteCommand` — auto-injects `--yes`/`--force`/`--dry-run`
 * flags and enforces the non-interactive guard before `func()` runs.
 */

import type { SentryContext } from "../../context.js";
import { deleteOrgAuthToken, listOrgAuthTokens } from "../../lib/api-client.js";
import { ORG_TARGET } from "../../lib/completion-target.js";
import { selectAccountForOrg } from "../../lib/db/auth.js";
import { ResolutionError, ValidationError } from "../../lib/errors.js";
import {
  escapeMarkdownInline,
  renderMarkdown,
  safeCodeSpan,
} from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { ID_KINDS, parseIdArguments } from "../../lib/id-arguments.js";
import { logger } from "../../lib/logger.js";
import {
  buildDeleteCommand,
  confirmByTyping,
  isConfirmationBypassed,
} from "../../lib/mutate-command.js";
import {
  type BoundArguments,
  boundArguments,
} from "../../lib/positional-parse.js";
import {
  type OrgInput,
  parseOrgInput,
  resolveOrgInput,
} from "../../lib/target-positional.js";
import type { OrgAuthToken } from "../../types/index.js";
import {
  DELETE_SCOPES,
  ensureTokenScopes,
  explainTokenForbidden,
} from "./shared.js";

const USAGE = "[<org>/]<token-id>";
const USAGE_HINT = `sentry token delete ${USAGE}`;
const log = logger.withTag("token.delete");

type DeleteFlags = {
  readonly yes: boolean;
  readonly force: boolean;
  readonly "dry-run": boolean;
  readonly json: boolean;
  readonly fields?: string[];
};

type DeleteResult = {
  deleted: boolean;
  org: string;
  id: string;
  name: string;
  dryRun?: boolean;
};

function formatTokenDeleted(result: DeleteResult): string {
  const label = `org auth token ${safeCodeSpan(result.name)} (id ${result.id})`;
  const org = `**${escapeMarkdownInline(result.org)}**`;
  if (result.dryRun) {
    return renderMarkdown(`Would revoke ${label} in ${org}. (dry run)`);
  }
  if (!result.deleted) {
    return "Cancelled.";
  }
  return renderMarkdown(`Revoked ${label} in ${org}.`);
}

/** Parsed token ID, organization and argument warnings. */
export type TokenInput = {
  /** Numeric ID of the token to revoke. */
  readonly id: string;
  /** Organization input, including a pasted URL's server. */
  readonly org: OrgInput;
  /** Parser warnings to show when resolving the target. */
  readonly warnings: readonly string[];
};

/** A token ID bound to the organization that owns it. */
type TokenArguments = BoundArguments<
  TokenInput,
  { readonly org: string; readonly id: string }
>;

/**
 * Parse one org-scoped token ID using the shared ID argument grammar.
 *
 * @throws {ContextError} When no ID is given
 * @throws {ValidationError} When the ID or organization is invalid, or
 *   more than one ID is given
 */
export function parseTokenArguments(args: readonly string[]): TokenInput {
  const { target, ids, baseUrl, warnings } = parseIdArguments(
    args,
    ID_KINDS.token,
    { usageHint: USAGE_HINT, multiple: true },
  );
  // Never choose one of several tokens for a destructive action.
  if (ids.length > 1) {
    throw new ValidationError(
      `Revoke one token at a time, not ${ids.length}: ${USAGE_HINT}`,
      "token-id",
    );
  }
  const [id = ""] = ids;
  const org = parseOrgInput(target, USAGE_HINT);
  return { id, org: baseUrl ? { ...org, baseUrl } : org, warnings };
}

/**
 * Find the token in the unpaginated list so confirmation can show its name.
 *
 * @throws {ResolutionError} When the org has no active token with this ID
 */
async function findToken(org: string, id: string): Promise<OrgAuthToken> {
  const tokens = await listOrgAuthTokens(org);
  const token = tokens.find((t) => t.id === id);
  if (!token) {
    throw new ResolutionError(
      `Org auth token ${id}`,
      `not found in ${org}`,
      `sentry token list ${org}`,
      ["It may already be revoked."],
    );
  }
  return token;
}

export const deleteCommand = buildDeleteCommand({
  docs: {
    brief: "Revoke an org auth token",
    customUsage: [USAGE],
    fullDescription:
      "Revoke an org auth token. Anything still using it (CI jobs, build " +
      "plugins) stops being able to upload right away.\n\n" +
      "Find the token ID with `sentry token list`.\n\n" +
      "Needs the org:write permission (org owners and managers). The first run " +
      "asks you to re-authorize so your CLI login can manage org auth tokens " +
      "(interactive runs only; skipped with --yes, --json, or --dry-run).",
    examples: [
      {
        description: "Revoke a token (auto-detect org)",
        command: "sentry token delete 12345",
      },
      {
        description: "Preview revoking a token",
        command: "sentry token delete my-org/12345 --dry-run",
      },
      {
        description: "Revoke without the confirmation prompt",
        command: "sentry token delete my-org/12345 --yes",
      },
    ],
  },
  output: {
    human: formatTokenDeleted,
  },
  parameters: {
    positional: boundArguments({
      placeholder: "org/token-id",
      brief: "[<org>/]<token-id> - Token to revoke",
      kind: ORG_TARGET,
      parse: parseTokenArguments,
      resolve: async (input, context: SentryContext) => {
        for (const warning of input.warnings) {
          log.warn(warning);
        }
        const { org } = await resolveOrgInput(
          input.org,
          context.cwd,
          USAGE_HINT,
        );
        return { org, id: input.id };
      },
    }),
  },
  async *func(this: SentryContext, flags: DeleteFlags, target: TokenArguments) {
    const { org, id } = await target.resolved;

    selectAccountForOrg(org);
    // Elevate before looking the token up and confirming, so an older login
    // authorizes once instead of failing with 403 after the prompt.
    const scopeMissing = await ensureTokenScopes(
      DELETE_SCOPES,
      "Revoking an org auth token",
    );

    let token: OrgAuthToken;
    try {
      token = await findToken(org, id);
    } catch (error) {
      throw explainTokenForbidden(error, DELETE_SCOPES, scopeMissing);
    }
    const result: DeleteResult = { deleted: false, org, id, name: token.name };

    if (flags["dry-run"]) {
      yield new CommandOutput({ ...result, dryRun: true });
      return;
    }

    if (!isConfirmationBypassed(flags)) {
      const confirmed = await confirmByTyping(
        token.name,
        `Type '${token.name}' to revoke this org auth token:`,
      );
      if (!confirmed) {
        yield new CommandOutput(result);
        return { hint: "Cancelled." };
      }
    }

    try {
      await deleteOrgAuthToken(org, id);
    } catch (error) {
      throw explainTokenForbidden(error, DELETE_SCOPES, scopeMissing);
    }
    yield new CommandOutput({ ...result, deleted: true });
  },
});
