/** Sentry resource IDs may be strings or numbers across API endpoints. */
export type SentryResourceId = string | number;

/** Identifiers and display names common to organizations, projects, and teams. */
export type SentryNamedResource<
  Id extends SentryResourceId = SentryResourceId,
> = {
  id: Id;
  slug: string;
  name: string;
};

/** Identifiers and title common to issue list and detail responses. */
export type SentryIssueIdentity<
  Id extends SentryResourceId = SentryResourceId,
> = {
  id: Id;
  shortId: string;
  title: string;
};
