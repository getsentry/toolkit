/** Native workflow documents returned by sentry alert commands. */
import type { GetOrganizationWorkflowResponse } from "@sentry/api";
import { vGetOrganizationWorkflowResponse } from "@sentry/api/valibot";
import {
  boolean,
  description,
  type InferOutput,
  looseObject,
  object,
  optional,
  partial,
  pipe,
  string,
} from "valibot";
import type { AlertCreateBody, AlertUpdateBody } from "../lib/api/alerts.js";
import { orgListItemSchema } from "./org-list.js";
import { DryRunOutputField, opaque, type WithOutputFields } from "./output.js";

const org = pipe(string(), description("Organization slug"));
export const AlertOutputFields = object({ org });
export const AlertViewOutputSchema = looseObject({
  ...vGetOrganizationWorkflowResponse.entries,
  ...AlertOutputFields.entries,
});
export type AlertViewOutput = WithOutputFields<
  GetOrganizationWorkflowResponse,
  typeof AlertOutputFields
>;
export const AlertListItemSchema = orgListItemSchema(
  vGetOrganizationWorkflowResponse,
);

const AlertMutationOutputFields = object({
  org,
  name: vGetOrganizationWorkflowResponse.entries.name,
  dryRun: DryRunOutputField,
  body: optional(
    pipe(
      opaque<AlertCreateBody | AlertUpdateBody>(),
      description("Exact native request body (--dry-run)"),
    ),
  ),
});
export const AlertMutationOutputSchema = looseObject({
  ...partial(vGetOrganizationWorkflowResponse).entries,
  ...AlertMutationOutputFields.entries,
});
export type AlertMutationOutput = WithOutputFields<
  Partial<GetOrganizationWorkflowResponse>,
  typeof AlertMutationOutputFields
>;

export const AlertDeleteOutputSchema = object({
  org,
  id: vGetOrganizationWorkflowResponse.entries.id,
  name: vGetOrganizationWorkflowResponse.entries.name,
  dryRun: DryRunOutputField,
  deleted: optional(
    pipe(boolean(), description("True when the alert was deleted")),
  ),
});
export type AlertDeleteOutput = InferOutput<typeof AlertDeleteOutputSchema>;
