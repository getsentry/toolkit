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
import type { SentryDeploy } from "../../types/index.js";
import { resolveReleaseTarget } from "./parse.js";

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
    fullDescription:
      "List all deploys recorded for a specific release.\n\n" +
      "Examples:\n" +
      "  sentry release deploys 1.0.0\n" +
      "  sentry release deploys my-org/1.0.0\n" +
      "  sentry release deploys 1.0.0 --json",
  },
  output: {
    human: formatDeployList,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "org/version",
          brief: "[<org>/]<version> - Release version",
          parse: String,
        },
      ],
    },
  },
  async *func(
    this: SentryContext,
    _flags: { readonly json: boolean; readonly fields?: string[] },
    target: string
  ) {
    const { cwd } = this;

    const { version, org } = await resolveReleaseTarget(
      target,
      USAGE_HINT,
      cwd
    );

    const deploys = await listReleaseDeploys(org, version);
    yield new CommandOutput(deploys);
  },
});
