/**
 * `--fields` / skill-reference schemas for the JSON output of the
 * `sentry alert issues|metrics create|edit|delete` commands.
 *
 * Issue alerts are workflows and metric alerts are detectors. Every field
 * that comes from the API is taken from the generated `@sentry/api/valibot`
 * schemas of the endpoint the command calls, following the `SentryTeamSchema`
 * pattern: `pipe(<generated field>, description(...))`, since the generated
 * schemas carry no descriptions. Only the fields the CLI adds (`org`,
 * `project`, the `status` label, `dryRun`, `deleted`) are written here.
 * Documentation only: nothing validates output against them.
 */

import {
  vCreateOrganizationProjectDetectorData,
  vCreateOrganizationProjectDetectorResponse,
  vCreateOrganizationWorkflowData,
  vCreateOrganizationWorkflowResponse,
  vGetOrganizationDetectorResponse,
  vGetOrganizationWorkflowResponse,
  vUpdateOrganizationDetectorResponse,
  vUpdateOrganizationWorkflowResponse,
} from "@sentry/api/valibot";
import {
  boolean,
  description,
  type GenericSchema,
  looseObject,
  optional,
  pipe,
  string,
} from "valibot";
import { DryRunOutputField } from "../../types/index.js";

// Fields the CLI adds to every alert mutation's output.
const org = pipe(string(), description("Organization slug"));
const project = pipe(string(), description("Project slug"));
const status = pipe(string(), description("Rule status (active, disabled)"));

/** The `id` and `name` of a generated rule schema, with descriptions. */
function ruleIdentity<T extends { id: GenericSchema; name: GenericSchema }>(
  entries: T,
) {
  return {
    id: pipe(entries.id, description("Alert rule ID")),
    name: pipe(entries.name, description("Alert rule name")),
  };
}

/** `create` output: the created rule, or the request body with `--dry-run`. */
function createEntries(
  response: { id: GenericSchema; name: GenericSchema },
  requestBody: GenericSchema,
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
        description("Request body that would be sent (--dry-run)"),
      ),
    ),
  };
}

/** `alert issues create`: the created rule, or the request body with `--dry-run`. */
export const IssueAlertCreateOutputSchema = looseObject({
  ...createEntries(
    vCreateOrganizationWorkflowResponse.entries,
    vCreateOrganizationWorkflowData.entries.body,
  ),
  project,
});

/** `alert metrics create`: the created rule, or the request body with `--dry-run`. */
export const MetricAlertCreateOutputSchema = looseObject(
  createEntries(
    vCreateOrganizationProjectDetectorResponse.entries,
    vCreateOrganizationProjectDetectorData.entries.body,
  ),
);

/** `alert issues edit`: the updated workflow plus the CLI's target fields. */
export const IssueAlertEditOutputSchema = looseObject({
  ...vUpdateOrganizationWorkflowResponse.entries,
  ...ruleIdentity(vUpdateOrganizationWorkflowResponse.entries),
  org,
  project,
  status,
});

/** `alert metrics edit`: the updated detector plus the CLI's target fields. */
export const MetricAlertEditOutputSchema = looseObject({
  ...vUpdateOrganizationDetectorResponse.entries,
  ...ruleIdentity(vUpdateOrganizationDetectorResponse.entries),
  org,
  status,
});

/** `delete` output: the deleted (or, with `--dry-run`, matched) rule. */
function deleteEntries(rule: { id: GenericSchema; name: GenericSchema }) {
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
export const IssueAlertDeleteOutputSchema = looseObject({
  ...deleteEntries(vGetOrganizationWorkflowResponse.entries),
  project,
});

/** `alert metrics delete`: the deleted (or, with `--dry-run`, matched) rule. */
export const MetricAlertDeleteOutputSchema = looseObject(
  deleteEntries(vGetOrganizationDetectorResponse.entries),
);
