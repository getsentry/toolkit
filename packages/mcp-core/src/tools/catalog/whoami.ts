import { z } from "zod";
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

export default defineTool({
  name: "whoami",
  title: "Who Am I",
  description: [
    "Identify the authenticated user in Sentry.",
    "",
    "Use this tool when you need to:",
    "- Get the user's name and email address.",
  ].join("\n"),
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
            await mapCredentialContexts(accounts, async ({ context }) =>
              toUser(
                await apiServiceFromContext(context).getAuthenticatedUser(),
              ),
            )
          ).map(({ value }) => value)
        : [toUser(await apiServiceFromContext(context).getAuthenticatedUser())];
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
