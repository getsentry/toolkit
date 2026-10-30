/**
 * sentry release deploy
 *
 * Create a deploy for a release.
 * Environment is the first positional arg (required), deploy name is optional second.
 */

import type { SentryContext } from "../../context.js";
import { createReleaseDeploy } from "../../lib/api-client.js";
import { buildCommand, numberParser } from "../../lib/command.js";
import { ContextError, ValidationError } from "../../lib/errors.js";
import {
  mdKvTable,
  renderMarkdown,
  safeCodeSpan,
} from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { formatRelativeTime } from "../../lib/formatters/time-utils.js";
import { DRY_RUN_ALIASES, DRY_RUN_FLAG } from "../../lib/mutate-command.js";
import type { SentryDeploy } from "../../types/index.js";
import { type ReleaseTarget, releaseParameter } from "./parse.js";

const USAGE_HINT =
  "sentry release deploy [<org>/]<version> <environment> [name]";

function formatDeployCreated(data: Record<string, unknown>): string {
  if (data.dryRun) {
    return renderMarkdown(
      `Would create deploy for ${safeCodeSpan(String(data.environment))} environment (dry run)`,
    );
  }
  const deploy = data as unknown as SentryDeploy;
  const lines: string[] = [];
  lines.push("## Deploy Created");
  lines.push("");
  const kvRows: [string, string][] = [];
  kvRows.push(["ID", deploy.id]);
  kvRows.push(["Environment", safeCodeSpan(deploy.environment)]);
  kvRows.push(["Name", deploy.name || "—"]);
  kvRows.push(["URL", deploy.url || "—"]);
  kvRows.push([
    "Started",
    deploy.dateStarted ? formatRelativeTime(deploy.dateStarted) : "—",
  ]);
  kvRows.push([
    "Finished",
    deploy.dateFinished ? formatRelativeTime(deploy.dateFinished) : "—",
  ]);
  lines.push(mdKvTable(kvRows));
  return renderMarkdown(lines.join("\n"));
}

/**
 * Check the deploy positionals after the release: the required
 * `environment` and an optional `name`.
 *
 * The deploy name is a single positional — multi-word names must be quoted
 * (e.g. `"Deploy #42"`), matching standard CLI conventions and avoiding the
 * silent `args.join(" ")` defect.
 *
 * @param environment - The deploy environment
 * @param name - Optional deploy name
 */
function parseDeployArgs(
  environment: string | undefined,
  name?: string,
): { environment: string; name?: string } {
  if (!environment) {
    throw new ContextError("Environment", USAGE_HINT, []);
  }
  return { environment, name: name || undefined };
}

export const deployCommand = buildCommand({
  docs: {
    brief: "Create a deploy for a release",
    fullDescription:
      "Create a deploy record for a release in a specific environment.",
    examples: [
      {
        description: "Create a deploy",
        command: "sentry release deploy 1.0.0 production",
      },
      {
        description: "Create a named deploy in an explicit organization",
        command: 'sentry release deploy my-org/1.0.0 staging "Deploy #42"',
      },
      {
        description: "Attach a deploy URL",
        command:
          "sentry release deploy 1.0.0 production --url https://example.com",
      },
      {
        description: "Record a deploy duration in seconds",
        command: "sentry release deploy 1.0.0 production --time 120",
      },
      {
        description: "Preview without creating",
        command: "sentry release deploy 1.0.0 production --dry-run",
      },
    ],
  },
  output: {
    human: formatDeployCreated,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        releaseParameter(USAGE_HINT, "[<org>/]<version> - Release version"),
        {
          placeholder: "environment",
          brief: "Deploy environment (e.g. production)",
          parse: String,
        },
        {
          placeholder: "name",
          brief:
            'Optional deploy name (quote multi-word names, e.g. "Deploy #42")',
          parse: String,
          optional: true,
        },
      ],
    },
    flags: {
      url: {
        kind: "parsed",
        parse: String,
        brief: "URL for the deploy",
        optional: true,
      },
      started: {
        kind: "parsed",
        parse: String,
        brief: "Deploy start time (ISO 8601)",
        optional: true,
      },
      finished: {
        kind: "parsed",
        parse: String,
        brief: "Deploy finish time (ISO 8601)",
        optional: true,
      },
      time: {
        kind: "parsed",
        parse: numberParser,
        brief:
          "Deploy duration in seconds (sets started = now - time, finished = now)",
        optional: true,
      },
      "dry-run": DRY_RUN_FLAG,
    },
    aliases: { ...DRY_RUN_ALIASES, t: "time" },
  },
  async *func(
    this: SentryContext,
    flags: {
      readonly url?: string;
      readonly started?: string;
      readonly finished?: string;
      readonly time?: number;
      readonly "dry-run": boolean;
      readonly json: boolean;
      readonly fields?: string[];
    },
    target: ReleaseTarget,
    environmentArg: string,
    nameArg?: string,
  ) {
    const { environment, name } = parseDeployArgs(environmentArg, nameArg);
    const { version, org } = await target.resolved;

    const body: Parameters<typeof createReleaseDeploy>[2] = { environment };
    if (name) {
      body.name = name;
    }
    if (flags.url) {
      body.url = flags.url;
    }
    if (flags.time !== undefined && (flags.started || flags.finished)) {
      throw new ValidationError(
        "--time cannot be used with --started or --finished. " +
          "Use either --time for duration-based timing, or --started/--finished for explicit timestamps.",
        "time",
      );
    }

    if (flags.time !== undefined) {
      const now = new Date();
      const started = new Date(now.getTime() - flags.time * 1000);
      body.dateStarted = started.toISOString();
      body.dateFinished = now.toISOString();
    } else {
      if (flags.started) {
        body.dateStarted = flags.started;
      }
      if (flags.finished) {
        body.dateFinished = flags.finished;
      }
    }

    if (flags["dry-run"]) {
      yield new CommandOutput({
        dryRun: true,
        version,
        environment,
        name,
        url: flags.url,
        dateStarted: body.dateStarted,
        dateFinished: body.dateFinished,
      });
      return { hint: "Dry run — no deploy was created." };
    }

    const deploy = await createReleaseDeploy(org, version, body);
    yield new CommandOutput(deploy);
  },
});
