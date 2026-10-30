/**
 * sentry integration delete
 *
 * Uninstall an integration from an organization.
 *
 * Uses `buildDeleteCommand` — auto-injects `--yes`/`--force`/`--dry-run`
 * flags and enforces the non-interactive guard before `func()` runs.
 */

import type { SentryContext } from "../../context.js";
import { deleteIntegration, getIntegration } from "../../lib/api-client.js";
import { ORG_TARGET } from "../../lib/completion-target.js";
import { ApiError, ValidationError } from "../../lib/errors.js";
import { renderMarkdown, safeCodeSpan } from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { ID_KINDS, parseIdArguments } from "../../lib/id-arguments.js";
import { runInteractiveLogin } from "../../lib/interactive-login.js";
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
import { ensureScopesForAction } from "../../lib/scope-recovery.js";
import {
  type OrgInput,
  parseOrgInput,
  resolveOrgInput,
} from "../../lib/target-positional.js";

const USAGE = "[<org>/]<integration-id>";
const USAGE_HINT = `sentry integration delete ${USAGE}`;

const log = logger.withTag("integration.delete");

/**
 * Scope Sentry requires (besides org:admin) to uninstall an integration.
 * Part of the CLI's default scopes, but logins from before it was added lack it.
 */
const DELETE_SCOPE = "org:integrations";

type DeleteResult = {
  deleted: boolean;
  org: string;
  id: string;
  name: string;
  provider: string;
  dryRun?: boolean;
};

type DeleteFlags = {
  readonly yes: boolean;
  readonly force: boolean;
  readonly "dry-run": boolean;
  readonly json: boolean;
  readonly fields?: string[];
};

function formatIntegrationDeleted(result: DeleteResult): string {
  const label = `${result.provider} integration ${safeCodeSpan(result.name)} (id ${result.id})`;
  if (result.dryRun) {
    return renderMarkdown(
      `Would remove ${label} from **${result.org}**. (dry run)`,
    );
  }
  if (!result.deleted) {
    return "Cancelled.";
  }
  return renderMarkdown(
    `Removed ${label} from **${result.org}**. Sentry finishes the uninstall in the background.`,
  );
}

/** Parsed `integration delete` arguments. */
export type IntegrationInput = {
  readonly id: string;
  /** The org the integration is installed in */
  readonly org: OrgInput;
  /** Warnings to log, such as for reversed arguments */
  readonly warnings: readonly string[];
};

/** An integration ID and the org it is installed in. */
export type ResolvedIntegration = { readonly org: string; readonly id: string };

/** The arguments of `integration delete`. */
export type IntegrationArguments = BoundArguments<
  IntegrationInput,
  ResolvedIntegration
>;

/**
 * Parse `[<org>/]<integration-id>` in the forms every ID-taking command
 * takes (see `id-arguments.ts`). Integrations are org-scoped, so a project
 * is rejected, and removing one takes exactly one ID. Has no side effects.
 *
 * @throws {ContextError} When no integration ID is given
 * @throws {ValidationError} When the ID is not numeric, the org is
 *   malformed, a project is given, or there is more than one ID
 */
export function parseIntegrationArguments(
  args: readonly string[],
): IntegrationInput {
  const { target, ids, baseUrl, warnings } = parseIdArguments(
    args,
    ID_KINDS.integration,
    { usageHint: USAGE_HINT, multiple: true },
  );
  // Not an ignored extra: deleting one of several IDs would surprise
  if (ids.length > 1) {
    throw new ValidationError(
      `Remove one integration at a time, not ${ids.length}: ${USAGE_HINT}`,
      "integration-id",
    );
  }
  const [id = ""] = ids;
  const org = parseOrgInput(target, USAGE_HINT);
  return { id, org: baseUrl ? { ...org, baseUrl } : org, warnings };
}

/**
 * Explain a 403 from the delete call. Sentry's 403 body names neither the
 * scope nor the role, and the generic hint ("re-authenticate") doesn't help
 * when the user's org role is what's missing.
 *
 * @param scopeMissing - The stored login lacks the scope and couldn't be
 *   elevated in this run (no interactive terminal, or prompts disabled by
 *   `--yes`/`--json`, which must never block on the authorization flow)
 */
function enrichDeleteError(error: unknown, scopeMissing: boolean): unknown {
  if (!(error instanceof ApiError && error.status === 403)) {
    return error;
  }
  const detail = scopeMissing
    ? `Your saved login predates the '${DELETE_SCOPE}' scope. Re-authorization needs an interactive terminal and is skipped with --yes or --json.\n  ` +
      `Run this command in a terminal without --yes or --json to re-authorize, or use an auth token with the '${DELETE_SCOPE}' scope.`
    : `Removing integrations requires the '${DELETE_SCOPE}' permission, which Sentry grants to org owners and managers.\n  ` +
      `If you use an auth token, make sure it has the '${DELETE_SCOPE}' scope.`;
  return new ApiError(
    "Not allowed to remove this integration",
    403,
    detail,
    error.endpoint,
  );
}

export const deleteCommand = buildDeleteCommand({
  docs: {
    brief: "Remove an installed integration",
    customUsage: [USAGE],
    fullDescription:
      "Uninstall an integration from an organization. Sentry also removes the " +
      "integration's linked issues and stops syncing with the provider.\n\n" +
      "Find the integration ID with `sentry integration list`.\n\n" +
      "Needs the org:integrations permission (org owners and managers). If your " +
      "login predates that scope, the CLI asks you to re-authorize first " +
      "(interactive runs only; skipped with --yes or --json).",
    examples: [
      {
        description: "Remove an integration (auto-detect org)",
        command: "sentry integration delete 12345",
      },
      {
        description: "Preview removing an integration",
        command: "sentry integration delete my-org/12345 --dry-run",
      },
      {
        description: "Remove without the confirmation prompt",
        command: "sentry integration delete my-org/12345 --yes",
      },
    ],
  },
  output: {
    human: formatIntegrationDeleted,
  },
  parameters: {
    positional: boundArguments({
      placeholder: "org/integration-id",
      brief: "[<org>/]<integration-id> - Integration to remove",
      kind: ORG_TARGET,
      parse: parseIntegrationArguments,
      resolve: async (
        input,
        context: SentryContext,
      ): Promise<ResolvedIntegration> => {
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
  async *func(
    this: SentryContext,
    flags: DeleteFlags,
    target: IntegrationArguments,
  ) {
    const { org, id } = await target.resolved;

    // Verify the integration exists before prompting for confirmation
    const integration = await getIntegration(org, id);
    const result: DeleteResult = {
      deleted: false,
      org,
      id,
      name: integration.name,
      provider: integration.provider.name,
    };

    if (flags["dry-run"]) {
      yield new CommandOutput({ ...result, dryRun: true });
      return;
    }

    // Elevate before confirming so an older login authorizes once instead of
    // failing with 403 and re-running the prompt via scope recovery.
    const elevation = await ensureScopesForAction(
      [DELETE_SCOPE],
      "Removing an integration",
      runInteractiveLogin,
    );
    if (elevation === "declined") {
      yield new CommandOutput(result);
      return { hint: "Authorization was not completed. Nothing was removed." };
    }

    // Confirmation gate — non-interactive guard is handled by buildDeleteCommand
    if (!isConfirmationBypassed(flags)) {
      const confirmed = await confirmByTyping(
        integration.name,
        `Type '${integration.name}' to remove this ${integration.provider.name} integration:`,
      );
      if (!confirmed) {
        yield new CommandOutput(result);
        return { hint: "Cancelled." };
      }
    }

    try {
      await deleteIntegration(org, id);
    } catch (error) {
      throw enrichDeleteError(error, elevation === "unavailable");
    }
    yield new CommandOutput({ ...result, deleted: true });
  },
});
