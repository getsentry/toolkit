import { z } from "zod";
import {
  AlertActionOptionSchema,
  AlertConditionOptionSchema,
} from "../../api-client/schema";
import { UserInputError } from "../../errors";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import {
  ParamOrganizationSlug,
  ParamProjectSlugOrAll,
  ParamRegionUrl,
} from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import { assertProjectRefWithinConstraint } from "./support/project-constraints";

const sectionSchema = z.enum(["actions", "conditions", "sources"]);
const conditionGroupSchema = z.enum(["workflow_trigger", "action_filter"]);

// Owns paginated Alert discovery; source results must respect the session's project.
export const getAlertOptionsOutputSchema = z.object({
  section: sectionSchema,
  actions: z.array(AlertActionOptionSchema).optional(),
  conditions: z.array(AlertConditionOptionSchema).optional(),
  conditionGroup: conditionGroupSchema.optional(),
  sources: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        type: z.string(),
        projectId: z.string().nullable(),
        enabled: z.boolean(),
        workflowIds: z.array(z.string()),
      }),
    )
    .optional(),
  nextCursor: z.string().nullable(),
  inputGuide: z
    .object({
      schemaFormat: z.string(),
      fieldNames: z.record(z.string(), z.string()),
      targetTypes: z.record(z.string(), z.string()),
      notes: z.array(z.string()),
    })
    .optional(),
});

export default defineTool({
  name: "get_alert_options",
  title: "Get Alert Options",
  skills: ["inspect"],
  requiredScopes: ["org:read", "project:read"],
  description: [
    "List what a Sentry Alert (notification workflow) can use: notification actions and integrations (Slack, Teams, email, PagerDuty) with their config schemas, trigger and filter conditions, or monitor and issue-stream sources.",
    "Use the results in create_alert_rule or update_alert_rule. Slack and Teams take channel names; Discord needs a channel ID or URL. Choices for dynamic Sentry App fields are not listed.",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    section: sectionSchema.describe(
      "`actions`: integrations and action config schemas. `conditions`: condition types and comparison schemas. `sources`: monitors and project issue streams to connect.",
    ),
    actionTypes: z
      .array(z.string().trim().min(1))
      .max(20)
      .nullable()
      .default(null)
      .describe(
        "Action types to include, such as slack, msteams, email, or pagerduty. Only with `actions`.",
      ),
    conditionGroup: conditionGroupSchema
      .nullable()
      .default(null)
      .describe(
        "Required with `conditions`: workflow_trigger for Alert triggers, action_filter for action group filters.",
      ),
    projectSlug: ParamProjectSlugOrAll.nullable().default(null),
    sourceTypes: z
      .array(z.string().trim().min(1))
      .max(20)
      .nullable()
      .default(null)
      .describe(
        "Monitor types to include, such as issue_stream (all issues in a project) or metric_issue. A source with no project covers all projects. Only with `sources`.",
      ),
    query: z
      .string()
      .trim()
      .min(1)
      .nullable()
      .default(null)
      .describe(
        "Sources only: Sentry monitor search, such as name:latency or workflow:123.",
      ),
    cursor: z
      .string()
      .nullable()
      .default(null)
      .describe("Next cursor from the same section and filters."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe("Maximum options to return in this page."),
  },
  outputSchema: getAlertOptionsOutputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  async handler(params, context: ServerContext) {
    const { section, organizationSlug } = params;
    if (params.actionTypes !== null && section !== "actions") {
      throw new UserInputError(
        "actionTypes can only be used with section='actions'.",
      );
    }
    if (params.conditionGroup !== null && section !== "conditions") {
      throw new UserInputError(
        "conditionGroup can only be used with section='conditions'.",
      );
    }
    if (
      (params.sourceTypes !== null || params.query !== null) &&
      section !== "sources"
    ) {
      throw new UserInputError(
        "sourceTypes and query can only be used with section='sources'.",
      );
    }
    const api = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });
    setTargetTagsAndAttributes({ organizationSlug });
    const pageParams = {
      organizationSlug,
      cursor: params.cursor ?? undefined,
      limit: params.limit,
    };
    if (section === "actions") {
      const page = await api.listAvailableAlertActionsPage({
        ...pageParams,
        types: params.actionTypes ?? undefined,
      });
      return structuredResult({
        section,
        ...page,
        inputGuide: {
          schemaFormat:
            "Sentry-native schemas; workflow action inputs use camelCase fields and string target types.",
          fieldNames: {
            target_identifier: "targetIdentifier",
            target_display: "targetDisplay",
            target_type: "targetType",
            fallthrough_type: "fallthroughType",
          },
          targetTypes: {
            "0": "specific",
            "1": "user",
            "2": "team",
            "3": "sentry_app",
            "4": "issue_owners",
          },
          notes: [
            "Integration actions also require integrationId; choose a returned integration and service ID when applicable.",
            "Email team IDs can be found with find_teams; member destinations require a user ID.",
            "Sentry App settings include static field choices. Dynamic fields require explicit values; preserve existing settings when editing unrelated fields.",
          ],
        },
      });
    }
    if (section === "conditions") {
      if (!params.conditionGroup) {
        throw new UserInputError(
          "conditionGroup is required with section='conditions'.",
        );
      }
      return structuredResult({
        section,
        conditionGroup: params.conditionGroup,
        ...(await api.listAlertConditionsPage({
          ...pageParams,
          group: params.conditionGroup,
        })),
      });
    }

    const requestedProjectSlug =
      params.projectSlug && params.projectSlug !== "all"
        ? params.projectSlug
        : undefined;
    if (requestedProjectSlug) {
      assertProjectRefWithinConstraint({
        resourceLabel: "Alert source",
        scopedProjectSlug: context.constraints.projectSlug,
        project: { slug: requestedProjectSlug },
      });
    }
    const projectSlug = context.constraints.projectSlug ?? requestedProjectSlug;
    const project = projectSlug
      ? await api.getProject({ organizationSlug, projectSlugOrId: projectSlug })
      : undefined;
    const page = await api.listDetectorsPage({
      ...pageParams,
      projectId: project ? String(project.id) : undefined,
      types: params.sourceTypes ?? undefined,
      query: params.query ?? undefined,
    });
    return structuredResult({
      section,
      sources: page.detectors
        .filter(
          (detector) => !project || detector.projectId === String(project.id),
        )
        .map((detector) => ({
          id: detector.id,
          name: detector.name,
          type: detector.type,
          projectId: detector.projectId,
          enabled: detector.enabled,
          workflowIds: detector.workflowIds ?? [],
        })),
      nextCursor: page.nextCursor,
    });
  },
});
