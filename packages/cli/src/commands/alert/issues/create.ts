/**
 * sentry alert issues create
 *
 * Create a project-scoped issue alert rule.
 */

import type { SentryContext } from "../../../context.js";
import {
  createIssueAlertRule,
  resolveErrorDetectorId,
} from "../../../lib/api-client.js";
import type { ParsedOrgProject } from "../../../lib/arg-parsing.js";
import { buildCommand, numberParser } from "../../../lib/command.js";
import {
  choiceListParser,
  choiceParser,
  parseEnvironment,
  parseOwner,
  parseText,
} from "../../../lib/completion-target.js";
import {
  ContextError,
  stringifyUnknown,
  ValidationError,
} from "../../../lib/errors.js";
import { CommandOutput } from "../../../lib/formatters/output.js";
import { DRY_RUN_ALIASES, DRY_RUN_FLAG } from "../../../lib/mutate-command.js";
import {
  type ResolvedTarget,
  resolveProjectBoundTargets,
} from "../../../lib/resolve-target.js";
import {
  type OrgProjectTarget,
  orgProjectTarget,
} from "../../../lib/target-positional.js";
import {
  ISSUE_MATCH_MODES,
  ISSUE_TRIGGER_NAMES,
  matchToLogicType,
  parseIssueConditions,
  parseJsonObjectList,
  parseMatchMode,
  triggerLogicType,
  validateIssueActions,
  validateIssueTriggers,
} from "../mutation-utils.js";
import type {
  IssueAlertCreateBody,
  IssueAlertCreateOutput,
} from "../../../output-schemas/alert.js";
import { IssueAlertCreateOutputSchema } from "../../../generated/output-schemas/alert.js";
import { sentry } from "../../../lib/app-identity.js";

const usageHint = () =>
  sentry`alert issues create <target> --name <name> --condition <json> --action <json>`;

type CreateFlags = {
  readonly name: string;
  readonly condition?: string[];
  readonly action?: string[];
  readonly frequency: number;
  readonly environment?: string;
  readonly filter?: string[];
  readonly "filter-match"?: "all" | "any";
  readonly owner?: string;
  readonly "dry-run": boolean;
  readonly json: boolean;
  readonly fields?: string[];
};

function formatCreated(result: IssueAlertCreateOutput): string {
  if (result.dryRun) {
    return `Would create issue alert rule '${result.name}' in ${result.org}/${result.project}.`;
  }
  return `Created issue alert rule ${result.id ?? "(unknown id)"} in ${result.org}/${result.project}: ${result.name} (${result.status ?? "active"}).`;
}

/**
 * Resolve the create target to exactly one project.
 *
 * @throws {ContextError} When no project is found
 * @throws {ValidationError} When the target matches several projects
 */
async function resolveCreateTarget(
  parsed: ParsedOrgProject,
  cwd: string,
): Promise<ResolvedTarget> {
  const { targets } = await resolveProjectBoundTargets(parsed, {
    cwd,
    usageHint: usageHint(),
  });
  const [target, ...others] = targets;
  if (!target) {
    throw new ContextError("Organization and project", usageHint());
  }
  if (others.length > 0) {
    throw new ValidationError(
      "Provide a target that resolves to exactly one project for create.",
      "target",
    );
  }
  return target;
}

export const createCommand = buildCommand({
  docs: {
    brief: "Create an issue alert rule",
    fullDescription:
      "Create a project-scoped issue alert rule. The target may be an explicit " +
      "<org>/<project>, an auto-detected project, or a bare project search when " +
      "it resolves to exactly one project.\n\n" +
      "Required fields:\n" +
      "  --name, --action (>=1), and --condition (>=1) or --filter (>=1)\n\n" +
      "Optional fields:\n" +
      "  --frequency, --environment, --filter, --filter-match, --owner\n\n" +
      "Conditions and actions are workflow-native JSON (this targets the\n" +
      "org-scoped workflows endpoint):\n" +
      "  --condition  a trigger data-condition: {type, comparison, conditionResult},\n" +
      `               or a trigger name: ${ISSUE_TRIGGER_NAMES.join(", ")}\n` +
      "  --action     an action: {type, data, config}\n" +
      "  --filter     an action-filter condition (same shape as --condition)\n\n" +
      "Without --condition, the alert checks its --filter conditions on every event.\n\n" +
      "Match mode: --filter-match all|any controls how the action-filter\n" +
      "conditions combine. Issue-alert triggers always evaluate as 'any-short'\n" +
      "(they fire on a single error detector), so there is no trigger match flag.",
    examples: [
      {
        description: "Alert on new issues and email a team",
        run: 'alert issues create my-org/my-project --name \'New Issues\' --condition \'{"type":"first_seen_event","comparison":true,"conditionResult":true}\' --action \'{"type":"email","data":{},"config":{"targetType":"team","targetIdentifier":"1"}}\'',
      },
      {
        description:
          "Preview a high-priority alert that emails a user at most every 30 minutes",
        run: 'alert issues create my-org/my-project --name \'High Priority\' --condition \'{"type":"new_high_priority_issue","comparison":true,"conditionResult":true}\' --action \'{"type":"email","data":{},"config":{"targetType":"user","targetIdentifier":"56789"}}\' --frequency 30 --dry-run',
      },
      {
        description: "Alert on new issues and regressions, using trigger names",
        run: 'alert issues create my-org/my-project --name \'New or Regressed\' --condition first-seen,regression --action \'{"type":"email","data":{},"config":{"targetType":"team","targetIdentifier":"1"}}\'',
      },
      {
        description:
          "Alert when an issue sees more than 50 events in a day (filters only, checked on every event)",
        run: 'alert issues create my-org/my-project --name \'Busy Issues\' --filter \'{"type":"event_frequency_count","comparison":{"value":50,"interval":"1d"},"conditionResult":true}\' --action \'{"type":"email","data":{},"config":{"targetType":"team","targetIdentifier":"1"}}\' --frequency 1440',
      },
    ],
  },
  output: {
    human: formatCreated,
    schema: IssueAlertCreateOutputSchema,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "target",
          brief:
            "<org>/<project>, auto-detected project, or <project> (search)",
          parse: orgProjectTarget((parsed, { cwd }) =>
            resolveCreateTarget(parsed, cwd),
          ),
          optional: true as const,
        },
      ],
    },
    flags: {
      name: {
        kind: "parsed",
        parse: parseText,
        brief: "Rule name",
      },
      condition: {
        kind: "parsed",
        parse: choiceListParser(ISSUE_TRIGGER_NAMES),
        variadic: true,
        optional: true,
        brief:
          "Trigger condition JSON or name such as first-seen (repeatable, or pass one JSON array)",
      },
      action: {
        kind: "parsed",
        parse: parseText,
        variadic: true,
        optional: true,
        brief: "Action object JSON (repeatable, or pass one JSON array)",
      },
      frequency: {
        kind: "parsed",
        parse: numberParser,
        default: 30,
        brief: "Frequency in minutes",
      },
      environment: {
        kind: "parsed",
        parse: parseEnvironment,
        optional: true,
        brief: "Environment filter",
      },
      filter: {
        kind: "parsed",
        parse: parseText,
        variadic: true,
        optional: true,
        brief: "Filter object JSON (repeatable, or pass one JSON array)",
      },
      "filter-match": {
        kind: "parsed",
        parse: choiceParser(ISSUE_MATCH_MODES, (value) =>
          parseMatchMode(value, "filter-match"),
        ),
        optional: true,
        brief: "Filter match mode: all or any",
      },
      owner: {
        kind: "parsed",
        parse: parseOwner,
        optional: true,
        brief: "Owner (team:user style value accepted by Sentry API)",
      },
      "dry-run": DRY_RUN_FLAG,
    },
    aliases: {
      ...DRY_RUN_ALIASES,
      c: "condition",
      a: "action",
      m: "filter-match",
    },
  },
  async *func(
    this: SentryContext,
    flags: CreateFlags,
    target: OrgProjectTarget<ResolvedTarget>,
  ) {
    if (!flags.name.trim()) {
      throw new ValidationError("Rule name cannot be empty.", "name");
    }
    if (flags.frequency <= 0) {
      throw new ValidationError(
        "frequency must be greater than 0.",
        "frequency",
      );
    }

    const conditions = parseIssueConditions(flags.condition);
    const actions = parseJsonObjectList(flags.action, "action");
    const filters = parseJsonObjectList(flags.filter, "filter");
    validateIssueTriggers(conditions, filters);
    validateIssueActions(actions);

    const { org, project } = await target.resolved;

    // Issue alerts fire on a project's error detector; connect via detector_ids.
    const detectorId = await resolveErrorDetectorId(org, project);

    // Assemble the workflow-shaped body. The user supplies workflow-native
    // conditions/actions; the CLI only builds the envelope (triggers +
    // action_filters + logic types), mirroring the backend dual-write mapping.
    const body: IssueAlertCreateBody = {
      name: flags.name,
      detectorIds: [detectorId],
      config: { frequency: flags.frequency },
      triggers: {
        logicType: triggerLogicType(),
        conditions: conditions ?? [],
      },
      actionFilters: [
        {
          logicType: matchToLogicType(flags["filter-match"]),
          conditions: filters ?? [],
          actions,
        },
      ],
    };
    if (flags.environment !== undefined) {
      body.environment = flags.environment;
    }
    if (flags.owner !== undefined) {
      body.owner = flags.owner;
    }

    if (flags["dry-run"]) {
      yield new CommandOutput({
        org,
        project,
        name: flags.name,
        dryRun: true,
        body,
      } satisfies IssueAlertCreateOutput);
      return { hint: "Dry run - no issue alert rule was created." };
    }

    const created = await createIssueAlertRule(org, body);
    yield new CommandOutput({
      org,
      project,
      id: stringifyUnknown(created.id ?? ""),
      name: stringifyUnknown(created.name ?? flags.name),
      status: stringifyUnknown(
        created.status ?? (created.enabled === false ? "disabled" : "active"),
      ),
    } satisfies IssueAlertCreateOutput);
  },
});
