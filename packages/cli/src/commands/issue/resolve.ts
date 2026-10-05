/**
 * sentry issue resolve
 *
 * Mark an issue as resolved, optionally tied to a release, the next
 * release, or a specific commit. Mirrors the "Resolve" dropdown in the
 * Sentry web UI.
 *
 * ## Flow
 *
 * 1. Parse positional issue arg (same formats as `issue view`)
 * 2. Parse `--in` spec (static release/next-release vs commit-requiring)
 * 3. Resolve to numeric group ID + org via `resolveIssue`
 * 4. For commit specs, resolve `{commit, repository}` via git + repo cache
 * 5. `updateIssueStatus(issueId, "resolved", { statusDetails, orgSlug })`
 * 6. Emit the updated issue
 */

import type { SentryContext } from "../../context.js";
import {
  parseResolveSpec,
  RESOLVE_COMMIT_EXPLICIT_PREFIX,
  RESOLVE_COMMIT_SENTINEL,
  RESOLVE_NEXT_RELEASE_SENTINEL,
  type ResolveStatusDetails,
  updateIssueStatus,
} from "../../lib/api-client.js";
import { buildCommand } from "../../lib/command.js";
import { ContextError } from "../../lib/errors.js";
import { formatIssueDetails, muted } from "../../lib/formatters/index.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { logger } from "../../lib/logger.js";
import type { SentryIssue } from "../../types/index.js";
import { resolveCommitSpec } from "./resolve-commit-spec.js";
import { issueIdPositional, resolveIssue } from "./utils.js";

const log = logger.withTag("issue.resolve");

/** Subcommand name passed to resolveIssue for error-hint construction. */
const COMMAND = "resolve";

type ResolveFlags = {
  readonly json: boolean;
  readonly fields?: string[];
  readonly in?: string;
};

/**
 * Wrapped result emitted by the command — carries the `in` spec so the
 * human formatter can surface it ("Resolved in 0.26.1", "Resolved in next
 * release", etc.) without re-parsing.
 */
type ResolveResult = {
  issue: SentryIssue;
  spec: ResolveStatusDetails | null;
};

/**
 * Describe the resolution spec for the human-readable output footer.
 *
 * Exhaustive over {@link ResolveStatusDetails} variants — any future
 * variant added to the union triggers a TypeScript error at the
 * `never`-typed `_exhaustive` assignment, preventing silent
 * misclassification.
 */
function describeSpec(spec: ResolveStatusDetails | null): string {
  if (!spec) {
    return "immediately";
  }
  if ("inRelease" in spec) {
    return `in release '${spec.inRelease}'`;
  }
  if ("inCommit" in spec) {
    return `in commit ${spec.inCommit.commit.slice(0, 12)} (repo '${spec.inCommit.repository}')`;
  }
  if ("inNextRelease" in spec) {
    return "in the next release";
  }
  // Exhaustiveness check — TypeScript will error here if a new variant
  // is added to ResolveStatusDetails without a matching branch above.
  const _exhaustive: never = spec;
  return _exhaustive;
}

function formatResolved(result: ResolveResult): string {
  const { issue, spec } = result;
  const head = `${muted("Resolved")} ${describeSpec(spec)}`;
  return `${head}\n\n${formatIssueDetails(issue)}`;
}

function jsonTransform(result: ResolveResult): unknown {
  return { ...result.issue, resolved_in: result.spec ?? undefined };
}

export const resolveCommand = buildCommand({
  docs: {
    brief: "Mark an issue as resolved",
    fullDescription:
      "Resolve an issue, optionally tied to a release or commit.\n\n" +
      "Resolution spec (--in / -i):\n" +
      `  ${RESOLVE_NEXT_RELEASE_SENTINEL}                        Resolve in the next release (tied to HEAD)\n` +
      `  ${RESOLVE_COMMIT_SENTINEL}                      Resolve in the current git HEAD — auto-detects repo\n` +
      `  ${RESOLVE_COMMIT_EXPLICIT_PREFIX}<repo>@<sha>       Resolve in an explicit repo + commit (repo must be registered in Sentry)\n` +
      "  <version>                    Resolve in this specific release (e.g., 0.26.1, spotlight@1.2.3)\n" +
      "  (omitted)                    Resolve immediately (no regression tracking)\n\n" +
      "@commit auto-detection requires a git repository whose 'origin' remote\n" +
      "maps to a Sentry-registered repo. The command errors out clearly if any\n" +
      "part of the detection fails — use the explicit form to override.\n\n" +
      "Examples:\n" +
      "  sentry issue resolve CLI-12Z\n" +
      "  sentry issue resolve CLI-12Z --in 0.26.1\n" +
      "  sentry issue resolve CLI-196 --in @next\n" +
      "  sentry issue resolve CLI-XX --in @commit\n" +
      "  sentry issue resolve CLI-XX -i @commit:getsentry/cli@abc123\n" +
      "  sentry issue resolve my-org/CLI-AB",
  },
  output: {
    human: formatResolved,
    jsonTransform,
  },
  parameters: {
    positional: issueIdPositional,
    flags: {
      in: {
        kind: "parsed",
        parse: String,
        brief: `Resolve in a release, next release, or commit ('<version>' | '${RESOLVE_NEXT_RELEASE_SENTINEL}' | '${RESOLVE_COMMIT_SENTINEL}' | '${RESOLVE_COMMIT_EXPLICIT_PREFIX}<repo>@<sha>')`,
        optional: true,
      },
    },
    aliases: {
      i: "in",
    },
  },
  async *func(this: SentryContext, flags: ResolveFlags, issueArg: string) {
    const { cwd } = this;
    const parsed = parseResolveSpec(flags.in);

    const { org, issue } = await resolveIssue({
      issueArg,
      cwd,
      command: COMMAND,
    });

    // Static specs (release / next-release / omitted) are ready to send.
    // Commit specs need git + Sentry-repo lookup before they become a
    // concrete { inCommit: { commit, repository } } payload.
    let statusDetails: ResolveStatusDetails | undefined;
    if (parsed?.kind === "static") {
      statusDetails = parsed.details;
    } else if (parsed?.kind === "commit") {
      if (!org) {
        // Sentry's InCommit validator looks up the repo by name within the
        // issue's org — we can't resolve the commit without knowing the org.
        throw new ContextError(
          "Organization",
          "sentry issue resolve <org>/<issue> --in @commit",
          [],
          "--in @commit needs an organization context to look up the Sentry repo registry."
        );
      }
      const resolved = await resolveCommitSpec(parsed.spec, org, cwd);
      statusDetails = { inCommit: resolved };
    }

    const updated = await updateIssueStatus(issue.id, "resolved", {
      statusDetails,
      orgSlug: org,
    });

    log.debug(
      `Resolved ${updated.shortId} ${describeSpec(statusDetails ?? null)}`
    );
    yield new CommandOutput<ResolveResult>({
      issue: updated,
      spec: statusDetails ?? null,
    });
  },
});
