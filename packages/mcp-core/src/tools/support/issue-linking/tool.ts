/** Shared inputs and scoped issue resolution for the external-reference tools. */
import { z } from "zod";
import { apiServiceFromContext } from "../../../internal/tool-helpers/api";
import {
  assertIssueWithinProjectConstraint,
  parseIssueParams,
} from "../../../internal/tool-helpers/issue";
import {
  ParamExternalIssueUrl,
  ParamIssueShortId,
  ParamIssueUrl,
  ParamOrganizationSlug,
  ParamRegionUrl,
} from "../../../schema";
import { setTagAndAttribute } from "../../../telem/scope";
import type { ServerContext } from "../../../types";

export const issueLinkInputSchema = {
  organizationSlug: ParamOrganizationSlug.optional(),
  regionUrl: ParamRegionUrl.nullable().default(null),
  issueId: ParamIssueShortId.optional(),
  issueUrl: ParamIssueUrl.optional(),
  externalIssueUrl: ParamExternalIssueUrl,
  integrationId: z
    .string()
    .regex(/^\d+$/)
    .optional()
    .describe(
      "Native integration ID, only needed when multiple installations match the URL.",
    ),
  appSlug: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Installed Sentry App slug. Inferred for Linear and Shortcut URLs; specify it for other Apps.",
    ),
};

export const issueLinkOutputSchema = z.object({
  organizationSlug: z.string(),
  issueId: z.string(),
  issueUrl: z.string(),
  externalIssue: z.object({
    url: z.string(),
    displayName: z.string().optional(),
    provider: z.string().optional(),
  }),
  status: z.enum(["linked", "already_linked", "not_linked"]),
});

/** Resolve the numeric issue ID and enforce project scope before any link mutation. */
export async function resolveIssueLinkContext(
  params: {
    organizationSlug?: string;
    regionUrl?: string | null;
    issueId?: string;
    issueUrl?: string;
  },
  context: ServerContext,
) {
  const { organizationSlug, issueId } = parseIssueParams({
    ...params,
    organizationSlug:
      context.constraints.organizationSlug ?? params.organizationSlug,
  });
  const apiService = apiServiceFromContext(context, {
    regionUrl: context.constraints.regionUrl ?? params.regionUrl ?? undefined,
  });
  setTagAndAttribute("organization.slug", organizationSlug);
  const issue = await apiService.getIssue({ organizationSlug, issueId });
  assertIssueWithinProjectConstraint({
    issue,
    projectSlug: context.constraints.projectSlug,
  });
  return { apiService, organizationSlug, issue };
}
