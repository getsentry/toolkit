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
  title: "Create DSN",
  skills: ["project-management"], // Only available in project-management skill
  requiredScopes: ["project:write"],
  description:
    "Create an additional DSN (client key) for an existing Sentry project, such as a separate production key. Returns the new key's ID, name, and DSN. create_project already provisions a DSN for a new project.",
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    projectSlug: ParamProjectSlug,
    name: z.string().trim().describe("Key name, such as `Production`."),
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
