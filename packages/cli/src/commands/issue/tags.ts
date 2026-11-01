/**
 * Inspect an issue's tag distribution across retained events.
 * Uses the public tag details endpoint: a top-values aggregate, not a
 * paginated list. Time and search filters are intentionally not exposed
 * because that endpoint ignores them.
 */

import { vGetOrganizationIssueTagResponse } from "@sentry/api/valibot";
import { description, object, pipe } from "valibot";
import type { SentryContext } from "../../context.js";
import { getIssueTag } from "../../lib/api-client.js";
import { buildCommand } from "../../lib/command.js";
import { parseEnvironment, parseTagKey } from "../../lib/completion-target.js";
import { ContextError } from "../../lib/errors.js";
import { formatIssueTags } from "../../lib/formatters/issue-tags.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import {
  applyFreshFlag,
  FRESH_ALIASES,
  FRESH_FLAG,
} from "../../lib/list-command.js";
import { withProgress } from "../../lib/polling.js";
import {
  type IssueTarget,
  issueParameter,
  requireIssueArgument,
} from "./positional.js";
import { buildCommandHint, resolveIssue } from "./utils.js";

type TagsFlags = {
  /** Emit the API response as JSON instead of a human table; defaults to false. */
  readonly json: boolean;
  /** Bypass cached API responses and project detection results; defaults to false. */
  readonly fresh: boolean;
  /** One literal environment name; undefined includes all environments. */
  readonly environment?: string;
};

export const tagsCommand = buildCommand({
  docs: {
    brief: "Show the top values of an issue tag",
    fullDescription:
      "Find which releases, servers, browsers, or other tag values concentrate an issue's events.\n\n" +
      "Returns up to 9 top values across retained events, ordered by count.\n" +
      "Percentages use the total retained event count, including missing values,\n" +
      "not just the sum of the displayed rows. This is not a lifetime count.\n" +
      "Use --environment to select one environment; the default includes all.\n" +
      "Time ranges, search queries, and pagination are not supported.\n\n" +
      "Use 'sentry issue view <issue>' to inspect tag keys on the latest event.\n" +
      "JSON preserves the API's key, name, totalValues, and topValues (including\n" +
      "counts and first/last seen timestamps). --fields selects top-level fields.",
    examples: [
      {
        description: "Show which releases concentrate an issue's events",
        command: "sentry issue tags my-org/FRONT-ABC release",
      },
      {
        description:
          "Inspect server distribution for the latest issue in production",
        command:
          "sentry issue tags @latest server_name --environment production",
      },
      {
        description: "Get browser counts and timestamps as JSON",
        command: "sentry issue tags FRONT-ABC browser.name --json",
      },
      {
        description: "Select the aggregate fields for a release distribution",
        command:
          "sentry issue tags FRONT-ABC release --json --fields key,totalValues,topValues",
      },
    ],
  },
  output: {
    human: formatIssueTags,
    schema: object({
      ...vGetOrganizationIssueTagResponse.entries,
      totalValues: pipe(
        vGetOrganizationIssueTagResponse.entries.totalValues,
        description(
          "Total retained events, including missing tag values; not a lifetime count",
        ),
      ),
      topValues: pipe(
        vGetOrganizationIssueTagResponse.entries.topValues,
        description(
          "Up to 9 values ordered by count, with nullable counts and first/last seen timestamps",
        ),
      ),
    }),
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        issueParameter({ command: "tags" }),
        {
          placeholder: "key",
          brief: "Tag key, e.g. release, server_name, browser.name",
          parse: parseTagKey,
        },
      ],
    },
    flags: {
      environment: {
        kind: "parsed",
        parse: parseEnvironment,
        brief: "Filter to one environment (default: all environments)",
        optional: true,
      },
      fresh: FRESH_FLAG,
    },
    aliases: { ...FRESH_ALIASES, e: "environment" },
  },
  async *func(
    this: SentryContext,
    flags: TagsFlags,
    target: IssueTarget,
    key: string,
  ) {
    applyFreshFlag(flags);
    const issueArg = requireIssueArgument(target.parsed, { command: "tags" });
    // Resolved here, not with `target.resolved`: recovery hints keep the
    // tag key and environment
    const trailingArgs =
      flags.environment === undefined
        ? [key]
        : [key, "--environment", flags.environment];
    const { org, issue } = await resolveIssue({
      issueArg,
      cwd: this.cwd,
      command: "tags",
      trailingArgs,
    });
    if (!org) {
      throw new ContextError(
        "Organization",
        buildCommandHint("tags", issueArg.text, undefined, trailingArgs),
      );
    }

    const tag = await withProgress(
      { message: "Fetching tag distribution...", json: flags.json },
      () => getIssueTag(org, issue.id, key, flags.environment),
    );
    yield new CommandOutput(tag);
    return {
      hint: `Issue: ${issue.shortId}. Environment: ${flags.environment ?? "all environments"}. Scope: retained events.`,
    };
  },
});
