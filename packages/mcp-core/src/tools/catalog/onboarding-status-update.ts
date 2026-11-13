import { z } from "zod";
import {
  AgenticOnboardingConnectStageInputSchema,
  AgenticOnboardingRunStatusUpdateSchema,
  AgenticOnboardingRunTokenSchema,
  AgenticOnboardingStageSchema,
  AgenticOnboardingStageStatusUpdateSchema,
  AgenticOnboardingStatusUpdateSchema,
} from "../../api-client/schema";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
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
      "Set only when the whole onboarding run has completed or failed.",
    ),
    eventNote: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .optional()
      .describe(
        "Short note for the progress UI; required when status is failed. Never include code, file paths, credentials, or error output.",
      ),
  })
  .strict();

const createProjectUpdateSchema = updateBaseSchema.extend({
  stage: z
    .literal("create_project")
    .describe("Creating or selecting Sentry projects."),
  extra: z
    .object({
      projectSlugs: z
        .array(z.string().trim().min(1))
        .min(1)
        .max(100)
        .describe(
          "Project slugs created or selected. Values accumulate across updates: add each project as it becomes usable, then send all of them when completed.",
        ),
    })
    .strict()
    .optional()
    .describe("Only for the create_project stage."),
});

const receiveVerificationErrorUpdateSchema = updateBaseSchema.extend({
  stage: z
    .literal("receive_verification_error")
    .describe("Waiting for the verification error to arrive in Sentry."),
  extra: z
    .object({
      issueIds: z
        .array(z.string().trim().min(1))
        .min(1)
        .max(100)
        .describe(
          "Issue IDs seen for the verification error. Values accumulate across updates: add each issue as it is confirmed, then send all of them when completed.",
        ),
    })
    .strict()
    .optional()
    .describe("Only for the receive_verification_error stage."),
});

const connectUpdateSchema = updateBaseSchema.extend({
  stage: AgenticOnboardingConnectStageInputSchema.describe(
    "Connecting to the user's Sentry account. connect_mcp is an older name for connect_agent.",
  ),
});

const updateWithoutExtraSchema = updateBaseSchema.extend({
  stage: AgenticOnboardingStageSchema.exclude([
    "connect_mcp",
    "create_project",
    "receive_verification_error",
  ]).describe("A stage that takes no extra metadata."),
});

const onboardingUpdateSchema = z
  .discriminatedUnion("stage", [
    connectUpdateSchema,
    createProjectUpdateSchema,
    receiveVerificationErrorUpdateSchema,
    updateWithoutExtraSchema,
  ])
  .describe("Progress update for one onboarding stage.");

type OnboardingUpdate = z.infer<typeof onboardingUpdateSchema>;

const CONNECTION_METHOD = "mcp" as const;

function withConnectionMethod(update: OnboardingUpdate) {
  if (update.stage !== "connect_agent" && update.stage !== "connect_mcp") {
    return update;
  }
  return {
    ...update,
    stage: "connect_agent" as const,
    extra: { method: CONNECTION_METHOD },
  };
}

export const onboardingStatusUpdateOutputSchema = z.object({
  continueUpdates: z
    .boolean()
    .describe("False when Sentry wants no further updates for this run."),
});

export default defineTool({
  name: "onboarding_status_update",
  title: "Update Onboarding Status",
  skills: ALL_SKILLS,
  includeInSkillDefinitions: false,
  requiredScopes: ["org:read"],
  description:
    "Report progress to Sentry's agentic onboarding (getting started) UI for one stage of an SDK setup run. Use only with a run token from the Sentry getting started skill, at the stage boundaries it describes. Returns whether Sentry wants further updates; stop when it does not.",
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    runToken: AgenticOnboardingRunTokenSchema.describe(
      "10-character run token from the Sentry getting started skill.",
    ),
    update: onboardingUpdateSchema,
  },
  outputSchema: onboardingStatusUpdateOutputSchema,
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
      ...withConnectionMethod(params.update),
    });

    const run = await apiService.updateAgenticOnboardingStatus({
      organizationSlug: params.organizationSlug,
      update,
    });

    return structuredResult({ continueUpdates: run.continueUpdates });
  },
});
