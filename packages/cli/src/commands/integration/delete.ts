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
import { ApiError, ContextError, ValidationError } from "../../lib/errors.js";
import { renderMarkdown, safeCodeSpan } from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { runInteractiveLogin } from "../../lib/interactive-login.js";
import {
  buildDeleteCommand,
  confirmByTyping,
  isConfirmationBypassed,
} from "../../lib/mutate-command.js";
import { resolveOrg } from "../../lib/resolve-target.js";
import { ensureScopesForAction } from "../../lib/scope-recovery.js";

const USAGE_HINT = "sentry integration delete [<org>/]<integration-id>";

/**
 * Scope Sentry requires (besides org:admin) to uninstall an integration.
 * Part of the CLI's default scopes, but logins from before it was added lack it.
 */
const DELETE_SCOPE = "org:integrations";

const INTEGRATION_ID_RE = /^\d+$/;

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

/**
 * Parse `[<org>/]<integration-id>`.
 *
 * @throws {ContextError} When the argument is empty
 * @throws {ValidationError} When the ID is not numeric
 */
export function parseIntegrationArg(arg: string | undefined): {
  id: string;
  orgSlug?: string;
} {
  const trimmed = arg?.trim();
  if (!trimmed) {
    throw new ContextError("Integration ID", USAGE_HINT, []);
  }
  const slash = trimmed.lastIndexOf("/");
  const orgSlug = slash > 0 ? trimmed.slice(0, slash) : undefined;
  const id = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  if (!INTEGRATION_ID_RE.test(id)) {
    throw new ValidationError(
      `Invalid integration ID '${id}'. Use the numeric ID from 'sentry integration list'.`,
      "integration-id",
    );
  }
  return { id, orgSlug };
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
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "org/integration-id",
          brief: "[<org>/]<integration-id> - Integration to remove",
          parse: String,
        },
      ],
    },
  },
  async *func(this: SentryContext, flags: DeleteFlags, target: string) {
    const { id, orgSlug } = parseIntegrationArg(target);
    const resolved = await resolveOrg({ org: orgSlug, cwd: this.cwd });
    if (!resolved) {
      throw new ContextError("Organization", USAGE_HINT);
    }
    const { org } = resolved;

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
