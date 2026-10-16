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
import {
  buildDeleteCommand,
  confirmByTyping,
  isConfirmationBypassed,
} from "../../lib/mutate-command.js";
import { OAUTH_SCOPES } from "../../lib/oauth.js";
import { resolveOrg } from "../../lib/resolve-target.js";

const USAGE_HINT = "sentry integration delete [<org>/]<integration-id>";

/** Scope Sentry requires (besides org:admin) to uninstall an integration. */
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
 * Turn a 403 into actionable guidance: the CLI's default OAuth login does not
 * request `org:integrations`, and Sentry's 403 body doesn't name the scope.
 */
function enrichDeleteError(error: unknown): unknown {
  if (error instanceof ApiError && error.status === 403) {
    const scopes = [...OAUTH_SCOPES, DELETE_SCOPE].join(",");
    return new ApiError(
      "Not allowed to remove this integration",
      403,
      `Removing integrations requires the '${DELETE_SCOPE}' or 'org:admin' scope and an owner or manager role.\n  ` +
        `Re-authenticate with: sentry auth refresh --scope ${scopes}\n  ` +
        "Or use an auth token that has the 'org:integrations' scope.",
      error.endpoint,
    );
  }
  return error;
}

export const deleteCommand = buildDeleteCommand({
  docs: {
    brief: "Remove an installed integration",
    fullDescription:
      "Uninstall an integration from an organization. Sentry also removes the " +
      "integration's linked issues and stops syncing with the provider.\n\n" +
      "Find the integration ID with `sentry integration list`.\n\n" +
      "Requires the org:integrations or org:admin scope.\n\n" +
      "Examples:\n" +
      "  sentry integration delete 12345\n" +
      "  sentry integration delete my-org/12345\n" +
      "  sentry integration delete my-org/12345 --yes\n" +
      "  sentry integration delete my-org/12345 --dry-run",
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
      throw enrichDeleteError(error);
    }
    yield new CommandOutput({ ...result, deleted: true });
  },
});
