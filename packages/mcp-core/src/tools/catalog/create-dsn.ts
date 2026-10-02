import { z } from "zod";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import {
  ParamOrganizationSlug,
  ParamProjectSlug,
  ParamRegionUrl,
} from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";

export const createDsnOutputSchema = z.object({
  dsn: z.object({
    id: z.string(),
    name: z.string(),
    dsn: z.string(),
  }),
});

export default defineTool({
  name: "create_dsn",
  skills: ["project-management"], // Only available in project-management skill
  requiredScopes: ["project:write"],
  description: [
    "Create an additional DSN for an EXISTING project.",
    "",
    "USE THIS TOOL WHEN:",
    "- Project already exists and needs additional DSN",
    "- 'Create another DSN for project X'",
    "- 'I need a production DSN for existing project'",
    "",
    "DO NOT USE for new projects (use create_project instead)",
    "",
    "Be careful when using this tool!",
    "",
    "<examples>",
    "### Create additional DSN for existing project",
    "```",
    "create_dsn(organizationSlug='my-organization', projectSlug='my-project', name='Production')",
    "```",
    "</examples>",
    "",
    "<hints>",
    "- If the user passes a parameter in the form of name/otherName, its likely in the format of <organizationSlug>/<projectSlug>.",
    "- If any parameter is ambiguous, you should clarify with the user what they meant.",
    "</hints>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    projectSlug: ParamProjectSlug,
    name: z
      .string()
      .trim()
      .describe("The name of the DSN to create, for example 'Production'."),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },
  outputSchema: createDsnOutputSchema,
  async handler(params, context: ServerContext) {
    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });
    const organizationSlug = params.organizationSlug;

    setTargetTagsAndAttributes(params);

    const clientKey = await apiService.createClientKey({
      organizationSlug,
      projectSlug: params.projectSlug,
      name: params.name,
    });
    return structuredResult({
      dsn: {
        id: String(clientKey.id),
        name: clientKey.name,
        dsn: clientKey.dsn.public,
      },
    });
  },
});
