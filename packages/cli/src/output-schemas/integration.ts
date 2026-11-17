/**
 * Output schemas of the `sentry integration` commands.
 */

import {
  description,
  looseObject,
  nullable,
  optional,
  pipe,
  string,
} from "valibot";
import { orgListItemSchema } from "./org-list.js";

/** Provider summary embedded in an installed integration. */
export const IntegrationProviderSchema = looseObject({
  key: pipe(string(), description("Provider key (e.g. github, slack)")),
  name: pipe(string(), description("Provider display name")),
});

/**
 * An integration installed on a Sentry organization.
 *
 * Returned by `/organizations/{org}/integrations/`. The list includes
 * integrations that are pending deletion, so `organizationIntegrationStatus`
 * can be `active`, `disabled`, or `pending_deletion`.
 */
export const SentryIntegrationSchema = pipe(
  looseObject({
    id: pipe(string(), description("Integration ID")),
    name: pipe(string(), description("Integration name (e.g. GitHub org)")),
    domainName: pipe(
      nullable(string()),
      description("External domain (e.g. github.com/getsentry)"),
    ),
    provider: pipe(IntegrationProviderSchema, description("Provider")),
    status: pipe(string(), description("Integration status")),
    organizationIntegrationStatus: pipe(
      string(),
      description("Status of the install in this organization"),
    ),
    externalId: optional(
      pipe(string(), description("Provider-side installation ID")),
    ),
  }),
  description("Installed Sentry integration"),
);

/** JSON output of `integration list`: an installed integration and the org it came from. */
export const IntegrationListItemSchema = orgListItemSchema(
  SentryIntegrationSchema,
);
