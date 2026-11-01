/**
 * sentry release deploys
 *
 * List deploys for a release.
 */

import type { SentryContext } from "../../context.js";
import { listReleaseDeploys } from "../../lib/api-client.js";
import { buildCommand } from "../../lib/command.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { type Column, formatTable } from "../../lib/formatters/table.js";
import { formatRelativeTime } from "../../lib/formatters/time-utils.js";
import { type SentryDeploy, SentryDeploySchema } from "../../types/index.js";
import { type ReleaseTarget, releaseParameter } from "./parse.js";

const USAGE_HINT = "sentry release deploys [<org>/]<version>";

const DEPLOY_COLUMNS: Column<SentryDeploy>[] = [
  { header: "ENVIRONMENT", value: (d) => d.environment },
  { header: "NAME", value: (d) => d.name || "—" },
  {
    header: "FINISHED",
    value: (d) => (d.dateFinished ? formatRelativeTime(d.dateFinished) : "—"),
  },
];

function formatDeployList(deploys: SentryDeploy[]): string {
  if (deploys.length === 0) {
    return "No deploys found for this release.";
  }
  return formatTable(deploys, DEPLOY_COLUMNS);
}

export const deploysCommand = buildCommand({
  docs: {
    brief: "List deploys for a release",
    fullDescription: "List all deploys recorded for a specific release.",
    examples: [
      {
        description: "List deploys for a release",
        command: "sentry release deploys 1.0.0",
      },
      {
        description: "List deploys for a release in an explicit organization",
        command: "sentry release deploys my-org/1.0.0",
      },
      {
        description: "Output as JSON",
        command: "sentry release deploys 1.0.0 --json",
      },
    ],
  },
  output: {
    human: formatDeployList,
    schema: SentryDeploySchema,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        releaseParameter(USAGE_HINT, "[<org>/]<version> - Release version"),
      ],
    },
  },
  async *func(
    this: SentryContext,
    _flags: { readonly json: boolean; readonly fields?: string[] },
    target: ReleaseTarget,
  ) {
    const { version, org } = await target.resolved;

    const deploys = await listReleaseDeploys(org, version);
    yield new CommandOutput(deploys);
  },
});
