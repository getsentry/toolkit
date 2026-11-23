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
  title: "Find DSNs",
  skills: ["project-management"], // DSN management is part of project setup
  requiredScopes: ["project:read"],
  description:
    "List the DSNs (client keys) for a Sentry project: the SENTRY_DSN an SDK uses to send events. Returns each key's ID, name, and DSN.",
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

    setTargetTagsAndAttributes(params);

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
