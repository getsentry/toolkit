/**
 * JSON output of the `sentry alert issues|metrics create|edit|delete`
 * commands, and the TypeScript types derived from it.
 *
 * Each schema is written once; the command's output type is its
 * `InferOutput`, so the compiler keeps the two in sync. The schemas feed
 * `--fields` completion, `--help` and the skill references; nothing
 * validates output against them at runtime.
 *
 * Issue alerts are workflows and metric alerts are detectors. Every field
 * that comes from the API is taken from the generated `@sentry/api/valibot`
 * schemas of the endpoint the command calls, following the `SentryTeamSchema`
 * pattern: `pipe(<generated field>, description(...))`, since the generated
 * schemas carry no descriptions. Only the fields the CLI adds (`org`,
 * `project`, the `status` label, `dryRun`, `deleted`) are written here.
 */

import type {
  UpdateOrganizationDetectorResponse,
  UpdateOrganizationWorkflowResponse,
} from "@sentry/api";
import {
  vCreateOrganizationProjectDetectorResponse,
  vCreateOrganizationWorkflowResponse,
  vGetOrganizationDetectorResponse,
  vGetOrganizationWorkflowResponse,
  vUpdateOrganizationDetectorResponse,
  vUpdateOrganizationWorkflowResponse,
} from "@sentry/api/valibot";
import {
  array,
  boolean,
  description,
  type GenericSchema,
  type InferOutput,
  looseObject,
  number,
  object,
  optional,
  picklist,
  pipe,
  record,
  string,
  unknown,
} from "valibot";
import { DryRunOutputField, type WithOutputFields } from "./output.js";

// Fields the CLI adds to every alert mutation's output.
const org = pipe(string(), description("Organization slug"));
const project = pipe(string(), description("Project slug"));
const status = pipe(string(), description("Rule status (active, disabled)"));

/** The `id` and `name` entries of a generated rule schema. */
type RuleEntries = { id: GenericSchema; name: GenericSchema };

/** The `id` and `name` of a generated rule schema, with descriptions. */
function ruleIdentity<T extends RuleEntries>(entries: T) {
  // Explicit input types: a generic schema leaves `description()`'s
  // input, and so the inferred output, as `unknown`.
  return {
    id: pipe(
      entries.id,
      description<InferOutput<T["id"]>, string>("Alert rule ID"),
    ),
    name: pipe(
      entries.name,
      description<InferOutput<T["name"]>, string>("Alert rule name"),
    ),
  };
}

/** JSON objects passed through from `--condition`, `--filter`, `--action`, `--trigger`. */
const jsonObjects = array(record(string(), unknown()));
const environment = optional(pipe(string(), description("Environment")));
const owner = optional(pipe(string(), description("Owner")));

/**
 * The workflow `alert issues create` sends. The CLI builds it from its
 * flags; the user's conditions, filters and actions pass through as given.
 */
export const IssueAlertCreateBodySchema = object({
  name: pipe(string(), description("Rule name")),
  detectorIds: pipe(
    array(number()),
    description("Error detector of the project the rule fires on"),
  ),
  config: object({
    frequency: pipe(
      number(),
      description("Minutes between notifications for one issue"),
    ),
  }),
  triggers: object({
    logicType: picklist(["any-short"]),
    conditions: pipe(jsonObjects, description("Trigger conditions")),
  }),
  actionFilters: array(
    object({
      logicType: picklist(["all", "any-short"]),
      conditions: pipe(jsonObjects, description("Filters")),
      actions: optional(pipe(jsonObjects, description("Actions"))),
    }),
  ),
  environment,
  owner,
});

/** Request body of `alert issues create`. */
export type IssueAlertCreateBody = InferOutput<
  typeof IssueAlertCreateBodySchema
>;

/**
 * The flat rule `alert metrics create` builds from its flags. The API layer
 * turns it into a detector before sending it (`buildDetectorBody`).
 */
export const MetricAlertCreateBodySchema = object({
  name: pipe(string(), description("Rule name")),
  query: pipe(string(), description("Event search query")),
  aggregate: pipe(string(), description("Aggregate the rule measures")),
  dataset: pipe(string(), description("Dataset")),
  timeWindow: pipe(number(), description("Time window in minutes")),
  triggers: pipe(jsonObjects, description("Thresholds or detector conditions")),
  projects: optional(pipe(array(string()), description("Project slugs"))),
  environment,
  owner,
  workflowIds: optional(
    pipe(array(number()), description("Alerts (workflows) to notify")),
  ),
});

/** Request body of `alert metrics create`, before the API layer translates it. */
export type MetricAlertCreateBody = InferOutput<
  typeof MetricAlertCreateBodySchema
>;

/** `create` output: the created rule, or the request body with `--dry-run`. */
function createEntries<R extends RuleEntries, B extends GenericSchema>(
  response: R,
  requestBody: B,
) {
  const { id, name } = ruleIdentity(response);
  return {
    org,
    id: optional(id),
    name,
    status: optional(status),
    dryRun: DryRunOutputField,
    body: optional(
      pipe(
        requestBody,
        description<InferOutput<B>, string>(
          "Request body that would be sent (--dry-run)",
        ),
      ),
    ),
  };
}

/** `alert issues create`: the created rule, or the request body with `--dry-run`. */
export const IssueAlertCreateOutputSchema = object({
  ...createEntries(
    vCreateOrganizationWorkflowResponse.entries,
    IssueAlertCreateBodySchema,
  ),
  project,
});

/** JSON output of `alert issues create`. */
export type IssueAlertCreateOutput = InferOutput<
  typeof IssueAlertCreateOutputSchema
>;

/** `alert metrics create`: the created rule, or the request body with `--dry-run`. */
export const MetricAlertCreateOutputSchema = object(
  createEntries(
    vCreateOrganizationProjectDetectorResponse.entries,
    MetricAlertCreateBodySchema,
  ),
);

/** JSON output of `alert metrics create`. */
export type MetricAlertCreateOutput = InferOutput<
  typeof MetricAlertCreateOutputSchema
>;

/** The rule ID, which `edit` always sets, as a string. */
const editedId = pipe(string(), description("Alert rule ID"));

/** Fields `alert issues edit` sets on the updated workflow. */
const IssueAlertEditFields = object({ org, project, id: editedId, status });

/** `alert issues edit`: the updated workflow plus the CLI's target fields. */
export const IssueAlertEditOutputSchema = looseObject({
  ...vUpdateOrganizationWorkflowResponse.entries,
  ...ruleIdentity(vUpdateOrganizationWorkflowResponse.entries),
  ...IssueAlertEditFields.entries,
});

/** JSON output of `alert issues edit`. */
export type IssueAlertEditOutput = WithOutputFields<
  UpdateOrganizationWorkflowResponse,
  typeof IssueAlertEditFields
>;

/** Fields `alert metrics edit` sets on the updated detector. */
const MetricAlertEditFields = object({ org, id: editedId, status });

/** `alert metrics edit`: the updated detector plus the CLI's target fields. */
export const MetricAlertEditOutputSchema = looseObject({
  ...vUpdateOrganizationDetectorResponse.entries,
  ...ruleIdentity(vUpdateOrganizationDetectorResponse.entries),
  ...MetricAlertEditFields.entries,
});

/** JSON output of `alert metrics edit`. */
export type MetricAlertEditOutput = WithOutputFields<
  UpdateOrganizationDetectorResponse,
  typeof MetricAlertEditFields
>;

/** `delete` output: the deleted (or, with `--dry-run`, matched) rule. */
function deleteEntries<R extends RuleEntries>(rule: R) {
  return {
    dryRun: DryRunOutputField,
    deleted: optional(
      pipe(boolean(), description("True when the rule was deleted")),
    ),
    org,
    ...ruleIdentity(rule),
  };
}

/** `alert issues delete`: the deleted (or, with `--dry-run`, matched) rule. */
export const IssueAlertDeleteOutputSchema = object({
  ...deleteEntries(vGetOrganizationWorkflowResponse.entries),
  project,
});

/** JSON output of `alert issues delete`. */
export type IssueAlertDeleteOutput = InferOutput<
  typeof IssueAlertDeleteOutputSchema
>;

/** `alert metrics delete`: the deleted (or, with `--dry-run`, matched) rule. */
export const MetricAlertDeleteOutputSchema = object(
  deleteEntries(vGetOrganizationDetectorResponse.entries),
);

/** JSON output of `alert metrics delete`. */
export type MetricAlertDeleteOutput = InferOutput<
  typeof MetricAlertDeleteOutputSchema
>;
