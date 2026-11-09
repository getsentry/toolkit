/**
 * Output schemas of the `sentry repo` commands.
 */

import {
  description,
  looseObject,
  nullable,
  object,
  optional,
  pipe,
  string,
} from "valibot";
import { orgListItemSchema } from "./org-list.js";

/** Repository provider (e.g., GitHub, GitLab) */
export const RepositoryProviderSchema = object({
  id: string(),
  name: string(),
});

/** A repository connected to a Sentry organization */
export const SentryRepositorySchema = pipe(
  looseObject({
    // Core identifiers (required)
    id: pipe(string(), description("Repository ID")),
    name: pipe(string(), description("Repository name")),
    url: pipe(nullable(string()), description("Repository URL")),
    provider: pipe(
      RepositoryProviderSchema,
      description("Version control provider"),
    ),
    status: pipe(string(), description("Integration status")),
    // Optional metadata
    dateCreated: optional(
      pipe(string(), description("Creation date (ISO 8601)")),
    ),
    integrationId: optional(pipe(string(), description("Integration ID"))),
    externalSlug: optional(
      nullable(pipe(string(), description("External slug (e.g. org/repo)"))),
    ),
    externalId: optional(nullable(pipe(string(), description("External ID")))),
  }),
  description("Sentry repository"),
);

/** JSON output of `repo list`: a repository and the org it came from. */
export const RepositoryListItemSchema = orgListItemSchema(
  SentryRepositorySchema,
);
