import { z } from "zod";
import { ApiClientError } from "../../api-client";
import { UserInputError } from "../../errors";
import { defineTool } from "../../internal/tool-helpers/define";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import {
  listCredentialContexts,
  mapCredentialContexts,
} from "../../internal/tool-helpers/credential-routing";
import { structuredResult } from "../../internal/tool-helpers/results";
import type { ServerContext } from "../../types";
import { ALL_SKILLS } from "../../skills";

const userSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string(),
});

export const whoamiOutputSchema = z.object({
  user: userSchema,
  /**
   * Every signed-in user when the server holds several logins (the stdio
   * server's stored CLI accounts), `user` first. Tool calls use the login
   * that can reach the organization they target.
   */
  accounts: z.array(userSchema).optional(),
  sessionConstraints: z
    .object({
      organizationSlug: z.string().optional(),
      projectSlug: z.string().optional(),
      regionUrl: z.string().optional(),
    })
    .nullable(),
});

function toUser(user: {
  id: string | number;
  name?: string | null;
  email: string;
}): z.infer<typeof userSchema> {
  return { id: String(user.id), name: user.name ?? null, email: user.email };
}

async function getUser(
  context: ServerContext,
): Promise<z.infer<typeof userSchema>> {
  try {
    return toUser(await apiServiceFromContext(context).getAuthenticatedUser());
  } catch (error) {
    // Sentry answers a bare 400 when no user stands behind the token, as with
    // org auth tokens (sentry src/sentry/api/endpoints/auth_index.py).
    if (error instanceof ApiClientError && error.status === 400) {
      throw new UserInputError(
        "This Sentry token is not tied to a user, so Sentry cannot say who it belongs to. Org auth tokens (`sntrys_...`) work this way, and they only carry the `org:ci` scope, which cannot read organizations, projects, or issues. Connect with a personal auth token or Sentry OAuth instead.",
        { cause: error },
      );
    }
    throw error;
  }
}

export default defineTool({
  name: "whoami",
  title: "Who Am I",
  description: "Identify the authenticated Sentry user: name and email.",
  inputSchema: {},
  outputSchema: whoamiOutputSchema,
  skills: ALL_SKILLS, // Foundational tool - available to all skills
  requiredScopes: [], // No specific scopes required - uses authentication token
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  async handler(params, context: ServerContext) {
    // User data endpoints (like /auth/) should never use regionUrl
    // as they must always query the main API server, not region-specific servers
    // API client will throw ApiClientError/ApiServerError which the MCP server wrapper handles
    const accounts = await listCredentialContexts(context);
    const users =
      accounts && accounts.length > 1
        ? (
            await mapCredentialContexts(accounts, ({ context }) =>
              getUser(context),
            )
          ).map(({ value }) => value)
        : [await getUser(context)];
    const [user] = users;

    const constraints = context.constraints;
    const sessionConstraints =
      constraints.organizationSlug ||
      constraints.projectSlug ||
      constraints.regionUrl
        ? {
            ...(constraints.organizationSlug
              ? { organizationSlug: constraints.organizationSlug }
              : {}),
            ...(constraints.projectSlug
              ? { projectSlug: constraints.projectSlug }
              : {}),
            ...(constraints.regionUrl
              ? { regionUrl: constraints.regionUrl }
              : {}),
          }
        : null;

    return structuredResult({
      user,
      ...(users.length > 1 ? { accounts: users } : {}),
      sessionConstraints,
    });
  },
});
