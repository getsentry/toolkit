import { z } from "zod";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import {
  ParamOrganizationSlug,
  ParamProjectSlug,
  ParamRegionUrl,
} from "../../schema";
import { setTagAndAttribute } from "../../telem/scope";
import type { ServerContext } from "../../types";

export const findDsnsOutputSchema = z.object({
  dsns: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      dsn: z.string(),
    }),
  ),
});

export default defineTool({
  name: "find_dsns",
  skills: ["project-management"], // DSN management is part of project setup
  requiredScopes: ["project:read"],
  description: [
    "List all Sentry DSNs for a specific project.",
    "",
    "Use this tool when you need to:",
    "- Retrieve a SENTRY_DSN for a specific project",
    "",
    "<hints>",
    "- If the user passes a parameter in the form of name/otherName, its likely in the format of <organizationSlug>/<projectSlug>.",
    "- If only one parameter is provided, and it could be either `organizationSlug` or `projectSlug`, its probably `organizationSlug`, but if you're really uncertain you might want to call `find_organizations()` first.",
    "</hints>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    projectSlug: ParamProjectSlug,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  outputSchema: findDsnsOutputSchema,
  async handler(params, context: ServerContext) {
    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });
    const organizationSlug = params.organizationSlug;

    setTagAndAttribute("organization.slug", organizationSlug);
    setTagAndAttribute("project.slug", params.projectSlug);

    const clientKeys = await apiService.listClientKeys({
      organizationSlug,
      projectSlug: params.projectSlug,
    });

    return structuredResult({
      dsns: clientKeys.map((clientKey) => ({
        id: String(clientKey.id),
        name: clientKey.name,
        dsn: clientKey.dsn.public,
      })),
    });
  },
});
