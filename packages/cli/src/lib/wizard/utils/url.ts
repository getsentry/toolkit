/**
 * Sentry URLs the wizards print after setup.
 */

/**
 * Returns the url to the Sentry project stream.
 *
 * Example: https://org-slug.sentry.io/issues/?project=1234567
 */
export function getIssueStreamUrl({
  url,
  orgSlug,
  projectId,
}: {
  url: string;
  orgSlug: string;
  projectId: string;
}): string {
  const urlObject = new URL(url);
  if (urlObject.host === "sentry.io") {
    urlObject.host = `${orgSlug}.${urlObject.host}`;
    urlObject.pathname = "/issues/";
  } else {
    urlObject.pathname = `/organizations/${orgSlug}/issues/`;
  }
  urlObject.searchParams.set("project", projectId);

  return urlObject.toString();
}
