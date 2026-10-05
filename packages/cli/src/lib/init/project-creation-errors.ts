export function formatMemberProjectCreationDisabledError(org: string): string {
  return (
    `Project creation is disabled for members in "${org}".\n` +
    "Ask an org owner to either enable project creation for members\n" +
    "or create the project for you. Once the project exists, run:\n" +
    `  sentry init ${org}/<project-slug>`
  );
}
