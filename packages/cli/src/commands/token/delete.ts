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
import { parseOrgTarget } from "../../lib/completion-target.js";
import { selectAccountForOrg } from "../../lib/db/auth.js";
import {
  ContextError,
  ResolutionError,
  ValidationError,
} from "../../lib/errors.js";
import {
  escapeMarkdownInline,
  renderMarkdown,
  safeCodeSpan,
} from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import {
  buildDeleteCommand,
  confirmByTyping,
  isConfirmationBypassed,
} from "../../lib/mutate-command.js";
import { resolveOrg } from "../../lib/resolve-target.js";
import type { OrgAuthToken } from "../../types/index.js";
import {
  DELETE_SCOPES,
  ensureTokenScopes,
  explainTokenForbidden,
  parseOrgScopedArg,
} from "./shared.js";

const USAGE_HINT = "sentry token delete [<org>/]<token-id>";

const TOKEN_ID_RE = /^\d+$/;

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

/**
 * Parse `[<org>/]<token-id>`.
 *
 * @throws {ContextError} When the argument is empty
 * @throws {ValidationError} When the ID is not numeric
 */
export function parseTokenArg(arg: string | undefined): {
  id: string;
  orgSlug?: string;
} {
  const { value: id, orgSlug } = parseOrgScopedArg(arg, "Token ID", USAGE_HINT);
  if (!TOKEN_ID_RE.test(id)) {
    throw new ValidationError(
      `Invalid token ID '${id}'. Use the numeric ID from 'sentry token list'.`,
      "token-id",
    );
  }
  return { id, orgSlug };
}

/**
 * Find the token so the confirmation can show its name. The endpoint has no
 * single-token GET, so this reads the (unpaginated) list.
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
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "org/token-id",
          brief: "[<org>/]<token-id> - Token to revoke",
          parse: parseOrgTarget,
        },
      ],
    },
  },
  async *func(this: SentryContext, flags: DeleteFlags, target: string) {
    const { id, orgSlug } = parseTokenArg(target);
    const resolved = await resolveOrg({ org: orgSlug, cwd: this.cwd });
    if (!resolved) {
      throw new ContextError("Organization", USAGE_HINT);
    }
    const { org } = resolved;

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
