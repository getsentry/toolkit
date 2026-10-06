/**
 * sentry release delete
 *
 * Permanently delete a Sentry release.
 *
 * Uses `buildDeleteCommand` — auto-injects `--yes`/`--force`/`--dry-run`
 * flags and enforces the non-interactive guard before `func()` runs.
 */

import type { SentryContext } from "../../context.js";
import { deleteRelease, getRelease } from "../../lib/api-client.js";
import { ApiError } from "../../lib/errors.js";
import { renderMarkdown, safeCodeSpan } from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import {
  buildDeleteCommand,
  confirmByTyping,
  isConfirmationBypassed,
} from "../../lib/mutate-command.js";
import { buildReleaseUrl } from "../../lib/sentry-urls.js";
import { resolveReleaseTarget } from "./parse.js";

const USAGE_HINT = "sentry release delete [<org>/]<version>";

type DeleteResult = {
  deleted: boolean;
  org: string;
  version: string;
  dryRun?: boolean;
};

function formatReleaseDeleted(result: DeleteResult): string {
  if (result.dryRun) {
    return renderMarkdown(
      `Would delete release ${safeCodeSpan(result.version)} from **${result.org}**. (dry run)`
    );
  }
  if (!result.deleted) {
    return "Cancelled.";
  }
  return renderMarkdown(
    `Release ${safeCodeSpan(result.version)} deleted from **${result.org}**.`
  );
}

/**
 * Enrich the raw 400 "health data" ApiError with an actionable message.
 * Returns the enriched error if it matches, otherwise returns the original.
 */
function enrichDeleteError(
  error: unknown,
  orgSlug: string,
  version: string
): unknown {
  if (
    error instanceof ApiError &&
    error.status === 400 &&
    error.detail?.includes("health data")
  ) {
    const url = buildReleaseUrl(orgSlug, version);
    return new ApiError(
      `Release '${version}' has health data and cannot be deleted`,
      400,
      "Releases with active session or crash-free data are protected by Sentry " +
        "and cannot be removed via the API. The health data must age out before " +
        `the release can be deleted.\n  Release: ${url}`,
      error.endpoint
    );
  }
  return error;
}

type DeleteFlags = {
  readonly yes: boolean;
  readonly force: boolean;
  readonly "dry-run": boolean;
  readonly json: boolean;
  readonly fields?: string[];
};

export const deleteCommand = buildDeleteCommand({
  docs: {
    brief: "Delete a release",
    fullDescription:
      "Permanently delete a Sentry release.\n\n" +
      "Examples:\n" +
      "  sentry release delete 1.0.0\n" +
      "  sentry release delete my-org/1.0.0\n" +
      "  sentry release delete 1.0.0 --yes\n" +
      "  sentry release delete 1.0.0 --dry-run",
  },
  output: {
    human: formatReleaseDeleted,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "org/version",
          brief: "[<org>/]<version> - Release version to delete",
          parse: String,
        },
      ],
    },
  },
  async *func(this: SentryContext, flags: DeleteFlags, target: string) {
    const { cwd } = this;

    const { version, org } = await resolveReleaseTarget(
      target,
      USAGE_HINT,
      cwd
    );

    // Verify the release exists before prompting for confirmation
    const release = await getRelease(org, version);

    // Dry-run mode: show what would be deleted
    if (flags["dry-run"]) {
      yield new CommandOutput({
        deleted: false,
        org,
        version,
        dryRun: true,
      });
      return;
    }

    // Confirmation gate — non-interactive guard is handled by buildDeleteCommand
    if (!isConfirmationBypassed(flags)) {
      const deployInfo =
        release.deployCount && release.deployCount > 0
          ? ` (${release.deployCount} deploy${release.deployCount > 1 ? "s" : ""})`
          : "";
      const confirmed = await confirmByTyping(
        version,
        `Type '${version}' to permanently delete this release${deployInfo}:`
      );
      if (!confirmed) {
        yield new CommandOutput({
          deleted: false,
          org,
          version,
        });
        return { hint: "Cancelled." };
      }
    }

    try {
      await deleteRelease(org, version);
    } catch (error) {
      throw enrichDeleteError(error, org, version);
    }
    yield new CommandOutput({ deleted: true, org, version });
  },
});
