import { z } from "zod";
import {
  AgenticOnboardingRunStatusUpdateSchema,
  AgenticOnboardingRunTokenSchema,
  AgenticOnboardingStageSchema,
  AgenticOnboardingStageStatusUpdateSchema,
  AgenticOnboardingStatusUpdateSchema,
} from "../../api-client/schema";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { ParamOrganizationSlug, ParamRegionUrl } from "../../schema";
import { ALL_SKILLS } from "../../skills";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";

const updateBaseSchema = z
  .object({
    status: AgenticOnboardingStageStatusUpdateSchema.describe(
      "The stage's current status.",
    ),
    runStatus: AgenticOnboardingRunStatusUpdateSchema.optional().describe(
      "Set only when the entire onboarding run has completed or failed.",
    ),
    eventNote: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .optional()
      .describe(
        "Short context to display with this progress event. Required when status is failed.",
      ),
  })
  .strict();

const createProjectUpdateSchema = updateBaseSchema.extend({
  stage: z
    .literal("create_project")
    .describe("Report progress while creating or selecting Sentry projects."),
  extra: z
    .object({
      projectSlugs: z
        .array(z.string().trim().min(1))
        .min(1)
        .max(100)
        .describe(
          "Sentry project slugs created or selected during onboarding. Values accumulate across updates; include each project as it becomes usable while active, then all known projects when completed.",
        ),
    })
    .strict()
    .optional()
    .describe("Project metadata accepted only by the create_project stage."),
});

const receiveVerificationErrorUpdateSchema = updateBaseSchema.extend({
  stage: z
    .literal("receive_verification_error")
    .describe(
      "Report progress while receiving the verification error in Sentry.",
    ),
  extra: z
    .object({
      issueIds: z
        .array(z.string().trim().min(1))
        .min(1)
        .max(100)
        .describe(
          "Sentry issue IDs observed after sending the verification error. Values accumulate across updates; include each matching issue as it is confirmed, then all known issues when completed.",
        ),
    })
    .strict()
    .optional()
    .describe(
      "Issue metadata accepted only by the receive_verification_error stage.",
    ),
});

const updateWithoutExtraSchema = updateBaseSchema.extend({
  stage: AgenticOnboardingStageSchema.exclude([
    "create_project",
    "receive_verification_error",
  ]).describe(
    "Report progress for a stage that does not accept extra metadata.",
  ),
});

const onboardingUpdateSchema = z
  .discriminatedUnion("stage", [
    createProjectUpdateSchema,
    receiveVerificationErrorUpdateSchema,
    updateWithoutExtraSchema,
  ])
  .describe("The stage-specific onboarding progress update.");

export default defineTool({
  name: "onboarding_status_update",
  skills: ALL_SKILLS,
  includeInSkillDefinitions: false,
  requiredScopes: ["org:read"],
  description: [
    "Update the progress shown in Sentry's agentic onboarding UI.",
    "",
    "Use this tool only when the Sentry getting started skill provides a run token. Call it at the workflow boundaries described by that skill.",
    "",
    "<hints>",
    "- Progress updates are operational UI state, not user analytics.",
    "- Keep eventNote brief and limited to context useful in the progress UI.",
    "- Do not include source code, repository paths, credentials, error output, or other sensitive data.",
    "- status is required for every update.",
    "- Set runStatus to completed or failed only when the entire onboarding run reaches that state.",
    "- A failed status requires a brief eventNote explaining the failure.",
    "</hints>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    runToken: AgenticOnboardingRunTokenSchema.describe(
      "The 10-character onboarding run token supplied by Sentry.",
    ),
    update: onboardingUpdateSchema,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler(params, context: ServerContext) {
    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? context.constraints.regionUrl ?? undefined,
    });

    setTargetTagsAndAttributes(params);

    const update = AgenticOnboardingStatusUpdateSchema.parse({
      schemaVersion: 1,
      runToken: params.runToken,
      ...params.update,
    });

    const run = await apiService.updateAgenticOnboardingStatus({
      organizationSlug: params.organizationSlug,
      update,
    });

    return `Onboarding status updated. Continue updates: ${run.continueUpdates ? "yes" : "no"}.`;
  },
});
