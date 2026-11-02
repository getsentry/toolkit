/**
 * `--fields` / skill-reference schemas for the JSON output of the
 * `sentry alert issues|metrics create|edit|delete` commands.
 *
 * Issue alerts are workflows and metric alerts are detectors, so `edit`
 * documents the `@sentry/api` update response it spreads, plus the fields
 * the CLI adds. Documentation only: nothing validates output against them.
 */

import {
  vUpdateOrganizationDetectorResponse,
  vUpdateOrganizationWorkflowResponse,
} from "@sentry/api/valibot";
import {
  boolean,
  description,
  looseObject,
  optional,
  pipe,
  record,
  string,
  unknown,
} from "valibot";
import { DryRunOutputField } from "../../types/index.js";

const org = pipe(string(), description("Organization slug"));
const project = pipe(string(), description("Project slug"));
const id = pipe(string(), description("Alert rule ID"));
const name = pipe(string(), description("Alert rule name"));
const status = pipe(string(), description("Rule status (active, disabled)"));

/** Fields shared by both `create` outputs. */
const createEntries = {
  org,
  id: optional(id),
  name,
  status: optional(status),
  dryRun: DryRunOutputField,
  body: optional(
    pipe(
      record(string(), unknown()),
      description("Request body that would be sent (--dry-run)"),
    ),
  ),
};

/** `alert issues create`: the created rule, or the request body with `--dry-run`. */
export const IssueAlertCreateOutputSchema = looseObject({
  ...createEntries,
  project,
});

/** `alert metrics create`: the created rule, or the request body with `--dry-run`. */
export const MetricAlertCreateOutputSchema = looseObject(createEntries);

/** `alert issues edit`: the updated workflow plus the CLI's target fields. */
export const IssueAlertEditOutputSchema = looseObject({
  ...vUpdateOrganizationWorkflowResponse.entries,
  org,
  project,
  id,
  status,
});

/** `alert metrics edit`: the updated detector plus the CLI's target fields. */
export const MetricAlertEditOutputSchema = looseObject({
  ...vUpdateOrganizationDetectorResponse.entries,
  org,
  id,
  status,
});

/** Fields shared by both `delete` outputs. */
const deleteEntries = {
  dryRun: DryRunOutputField,
  deleted: optional(
    pipe(boolean(), description("True when the rule was deleted")),
  ),
  org,
  id,
  name,
};

/** `alert issues delete`: the deleted (or, with `--dry-run`, matched) rule. */
export const IssueAlertDeleteOutputSchema = looseObject({
  ...deleteEntries,
  project,
});

/** `alert metrics delete`: the deleted (or, with `--dry-run`, matched) rule. */
export const MetricAlertDeleteOutputSchema = looseObject(deleteEntries);
