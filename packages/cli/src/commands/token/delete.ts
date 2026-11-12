/**
 * sentry token delete
 *
 * Revoke an org auth token by ID or name.
 *
 * Uses `buildDeleteCommand` — auto-injects `--yes`/`--force`/`--dry-run`
 * flags and enforces the non-interactive guard before `func()` runs.
 */

import { inlineCode, text } from "@sentry/toolkit-core/markdown";
import type { SentryContext } from "../../context.js";
import { deleteOrgAuthToken, listOrgAuthTokens } from "../../lib/api-client.js";
import { sentry } from "../../lib/app-identity.js";
import { ORG_TARGET } from "../../lib/completion-target.js";
import { selectAccountForOrg } from "../../lib/db/auth.js";
import { ResolutionError, ValidationError } from "../../lib/errors.js";
import { renderMarkdown } from "../../lib/formatters/markdown.js";
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
  parseOrgScopedArg,
} from "./shared.js";

const USAGE = "[<org>/]<token-id-or-name>";
const usageHint = () => sentry`token delete ${USAGE}`;
const log = logger.withTag("token.delete");

/** Sentry org (`sntrys_`) and user (`sntryu_`) auth token values. */
const TOKEN_VALUE_PATTERN = /sntry[su]_/;

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
  const label = `org auth token ${inlineCode(result.name)} (id ${result.id})`;
  const org = `**${text(result.org)}**`;
  if (result.dryRun) {
    return renderMarkdown(`Would revoke ${label} in ${org}. (dry run)`);
  }
  if (!result.deleted) {
    return "Cancelled.";
  }
  return renderMarkdown(`Revoked ${label} in ${org}.`);
}

/** The token to revoke: its numeric ID, or its name. */
type TokenRef =
  | { readonly id: string; readonly name?: undefined }
  | { readonly name: string; readonly id?: undefined };

/** Parsed token reference, organization and argument warnings. */
export type TokenInput = TokenRef & {
  /** Organization input, including a pasted URL's server. */
  readonly org: OrgInput;
  /** Parser warnings to show when resolving the target. */
  readonly warnings: readonly string[];
};

/** A token reference bound to the organization that owns it. */
type TokenArguments = BoundArguments<
  TokenInput,
  { readonly org: string; readonly ref: TokenRef }
>;

/**
 * Parse one org-scoped token ID or name using the shared ID argument
 * grammar. Like `token create`, `<org>/<name>` names the org when the part
 * before the first `/` is an org slug.
 *
 * @throws {ContextError} When no ID or name is given
 * @throws {ValidationError} When the organization is invalid, or more than
 *   one ID is given
 */
export function parseTokenArguments(args: readonly string[]): TokenInput {
  // Token values are secrets: refuse them without echoing them back into
  // the terminal, logs, or error reports.
  if (args.some((arg) => TOKEN_VALUE_PATTERN.test(arg))) {
    throw new ValidationError(
      "That looks like a token value, not a token ID or name. Use the ID " +
        `or name from '${sentry`token list`}'.`,
      "token-id",
    );
  }
  const { target, ids, name, baseUrl, warnings } = parseIdArguments(
    args,
    ID_KINDS.token,
    { usageHint: usageHint(), multiple: true },
  );
  // Never choose one of several tokens for a destructive action.
  if (ids.length > 1) {
    throw new ValidationError(
      `Revoke one token at a time, not ${ids.length}: ${usageHint()}`,
      "token-id",
    );
  }
  let orgArg = target;
  let ref: TokenRef = { id: ids[0] ?? "" };
  // The grammar reads `<org>/<a>/<1>` as `<org>/<project>/<id>`, but tokens
  // have no project: like `token create`, it's the org and a name with a slash.
  const slashName =
    target?.includes("/") && !target.endsWith("/") && args.length === 1
      ? args[0]
      : undefined;
  const unscopedName = slashName ?? (target === undefined ? name : undefined);
  if (unscopedName !== undefined) {
    const scoped = parseOrgScopedArg(
      unscopedName,
      "Token ID or name",
      usageHint(),
    );
    orgArg = scoped.orgSlug;
    ref = { name: scoped.value };
  } else if (name !== undefined) {
    ref = { name };
  }
  const org = parseOrgInput(orgArg, usageHint());
  return { ...ref, org: baseUrl ? { ...org, baseUrl } : org, warnings };
}

/**
 * Find the token in the unpaginated list so confirmation can show its name.
 *
 * @throws {ResolutionError} When the org has no active token with this ID
 *   or name
 * @throws {ValidationError} When several tokens have this name
 */
async function findToken(org: string, ref: TokenRef): Promise<OrgAuthToken> {
  const tokens = await listOrgAuthTokens(org);
  const matches =
    ref.id === undefined
      ? tokens.filter((t) => t.name === ref.name)
      : tokens.filter((t) => t.id === ref.id);
  const [token] = matches;
  if (!token) {
    const label = ref.id ?? `'${ref.name}'`;
    throw new ResolutionError(
      `Org auth token ${label}`,
      `not found in ${org}`,
      sentry`token list ${org}`,
      ["It may already be revoked."],
    );
  }
  // Names aren't unique, and revoking the wrong token breaks whatever uses it.
  if (matches.length > 1) {
    const ids = matches.map((t) => t.id).join(", ");
    throw new ValidationError(
      `${matches.length} org auth tokens in ${org} are named '${ref.name}' ` +
        `(IDs ${ids}). Pass the ID instead: ${sentry`token delete ${org}/<token-id>`}`,
      "token-id",
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
      "Takes the token's numeric ID or name from `sentry token list`, not " +
      "the token value, so the secret never needs to be pasted into a " +
      "terminal. Names aren't unique: when several tokens share one, pass " +
      "the ID.\n\n" +
      "Needs the org:write permission (org owners and managers). The first run " +
      "asks you to re-authorize so your CLI login can manage org auth tokens " +
      "(interactive runs only; skipped with --yes, --json, or --dry-run).",
    examples: [
      {
        description: "Revoke token ID 12345 (auto-detect org)",
        run: "token delete 12345",
      },
      {
        description: "Revoke the token named github-actions",
        run: "token delete my-org/github-actions",
      },
      {
        description: "Preview revoking token ID 12345",
        run: "token delete my-org/12345 --dry-run",
      },
      {
        description: "Revoke without the confirmation prompt",
        run: "token delete my-org/12345 --yes",
      },
    ],
  },
  output: {
    human: formatTokenDeleted,
  },
  parameters: {
    positional: boundArguments({
      placeholder: "org/token-id-or-name",
      brief:
        "[<org>/]<token-id-or-name> - ID or name from sentry token list (not the token value)",
      kind: ORG_TARGET,
      parse: parseTokenArguments,
      resolve: async (input, context: SentryContext) => {
        for (const warning of input.warnings) {
          log.warn(warning);
        }
        const { org } = await resolveOrgInput(
          input.org,
          context.cwd,
          usageHint(),
        );
        const ref: TokenRef =
          input.id === undefined ? { name: input.name } : { id: input.id };
        return { org, ref };
      },
    }),
  },
  async *func(this: SentryContext, flags: DeleteFlags, target: TokenArguments) {
    const { org, ref } = await target.resolved;

    selectAccountForOrg(org);
    // Elevate before looking the token up and confirming, so an older login
    // authorizes once instead of failing with 403 after the prompt.
    const scopeMissing = await ensureTokenScopes(
      DELETE_SCOPES,
      "Revoking an org auth token",
    );

    let token: OrgAuthToken;
    try {
      token = await findToken(org, ref);
    } catch (error) {
      throw explainTokenForbidden(error, DELETE_SCOPES, scopeMissing);
    }
    const { id, name } = token;
    const result: DeleteResult = { deleted: false, org, id, name };

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
