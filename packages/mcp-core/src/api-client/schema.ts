/**
 * Zod schemas for Sentry API response validation.
 *
 * This module contains comprehensive Zod schemas that validate and type-check
 * responses from Sentry's REST API. All schemas are designed to handle Sentry's
 * flexible data model where most fields can be null or optional.
 *
 * Key Design Principles:
 * - Use .passthrough() for objects that may contain additional fields
 * - Support both string and number IDs (Sentry's legacy/modern ID formats)
 * - Handle nullable fields gracefully throughout the schema hierarchy
 * - Use union types for polymorphic data (events, assignedTo, etc.)
 *
 * Schema Categories:
 * - **Core Resources**: Users, Organizations, Teams, Projects
 * - **Issue Management**: Issues, Events, Assignments
 * - **Release Management**: Releases, Commits, Deployments
 * - **Search & Discovery**: Tags, Error Search, Span Search
 * - **Integrations**: Client Keys (DSNs), Autofix
 *
 * @example Schema Usage
 * ```typescript
 * import { IssueListSchema } from "./schema";
 *
 * const response = await fetch("/api/0/organizations/my-org/issues/");
 * const issues = IssueListSchema.parse(await response.json());
 * // TypeScript now knows the exact shape of issues
 * ```
 *
 * @example Error Handling
 * ```typescript
 * const { data, success, error } = ApiErrorSchema.safeParse(response);
 * if (success) {
 *   throw new ApiError(data.detail, statusCode);
 * }
 * ```
 */
import { z } from "zod";

/**
 * Schema for Sentry API error responses.
 *
 * Uses .passthrough() to allow additional fields that may be present
 * in different error scenarios.
 */
export const ApiErrorSchema = z
  .object({
    detail: z.string(),
  })
  .passthrough();

export const UserSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    name: z.string().nullable(),
    email: z.string(),
  })
  .passthrough();

/**
 * Schema for Sentry organization API responses.
 *
 * Handles organizations from both Sentry's Cloud Service and self-hosted installations.
 * The links object and regionUrl field are optional to support self-hosted Sentry
 * instances that may not include these fields or return empty values.
 */
export const OrganizationSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    slug: z.string(),
    name: z.string(),
    links: z
      .object({
        regionUrl: z
          .string()
          .refine(
            (value) => !value || z.string().url().safeParse(value).success,
            {
              message:
                "Must be a valid URL or empty string (for self-hosted Sentry)",
            },
          )
          .optional(),
        organizationUrl: z.string().url(),
      })
      .optional(),
    // Only returned by the organization details endpoint, not the list endpoint.
    features: z.array(z.string()).optional(),
    hideAiFeatures: z.boolean().optional(),
  })
  .passthrough();

export const OrganizationListSchema = z.array(OrganizationSchema);

export const TeamSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    slug: z.string(),
    name: z.string(),
  })
  .passthrough();

export const TeamListSchema = z.array(TeamSchema);

export const ProjectSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    slug: z.string(),
    name: z.string(),
    platform: z.string().nullable().optional(),
    hasProfiles: z.boolean().optional(),
    hasReplays: z.boolean().optional(),
    hasLogs: z.boolean().optional(),
    firstTransactionEvent: z.boolean().optional(),
  })
  .passthrough();

export const ProjectListSchema = z.array(ProjectSchema);

export const RepositorySchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    name: z.string(),
    provider: z
      .object({
        id: z.string(),
        name: z.string(),
      })
      .passthrough(),
    status: z.string(),
    externalSlug: z.string().optional(),
    externalId: z.string().optional(),
    integrationId: z.union([z.string(), z.number()]).nullable().optional(),
  })
  .passthrough();

export const RepositoryListSchema = z.array(RepositorySchema);

export const ProjectRepositoryMappingSchema = z
  .object({
    created: z.number(),
    updated: z.number(),
    errors: z.number(),
    mappings: z.array(
      z
        .object({
          stackRoot: z.string(),
          sourceRoot: z.string(),
          status: z.string(),
          detail: z.string().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

/**
 * Dashboard schemas validated against getsentry/sentry:
 * - `src/sentry/dashboards/endpoints/organization_dashboards.py`
 * - `src/sentry/dashboards/endpoints/organization_dashboard_details.py`
 * - `src/sentry/api/serializers/models/dashboard.py`
 */
export const DashboardPermissionsSchema = z
  .object({
    isEditableByEveryone: z.boolean().optional(),
    teamsWithEditAccess: z.array(z.union([z.string(), z.number()])).optional(),
  })
  .passthrough();

export const DashboardWidgetPreviewSchema = z
  .object({
    displayType: z.string(),
    layout: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .passthrough();

export const DashboardWidgetQuerySchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    name: z.string(),
    fields: z.array(z.string()),
    aggregates: z.array(z.string()),
    columns: z.array(z.string()),
    fieldAliases: z.array(z.string()),
    conditions: z.string(),
    orderby: z.string(),
    widgetId: z.union([z.string(), z.number()]),
    isHidden: z.boolean().optional(),
    selectedAggregate: z.number().nullable().optional(),
    linkedDashboards: z
      .array(
        z
          .object({
            field: z.string(),
            dashboardId: z.union([z.string(), z.number()]),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export const DashboardWidgetSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    title: z.string(),
    description: z.string().nullable().optional(),
    displayType: z.string(),
    interval: z.string().nullable().optional(),
    dateCreated: z.string(),
    dashboardId: z.union([z.string(), z.number()]),
    queries: z.array(DashboardWidgetQuerySchema).default([]),
    limit: z.number().nullable().optional(),
    widgetType: z.string().nullable().optional(),
    layout: z.record(z.string(), z.unknown()).nullable().optional(),
    datasetSource: z.string().optional(),
  })
  .passthrough();

export const DashboardFiltersSchema = z.record(z.string(), z.unknown());

export const DashboardListItemSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    title: z.string(),
    dateCreated: z.string(),
    createdBy: z.unknown().nullable().optional(),
    environment: z.array(z.string()).default([]),
    filters: DashboardFiltersSchema.default({}),
    lastVisited: z.string().nullable().optional(),
    widgetDisplay: z.array(z.string()).default([]),
    widgetPreview: z.array(DashboardWidgetPreviewSchema).default([]),
    permissions: DashboardPermissionsSchema.nullable().optional(),
    isFavorited: z.boolean().optional(),
    projects: z.array(z.number()).default([]),
    prebuiltId: z.union([z.string(), z.number()]).nullable().optional(),
  })
  .passthrough();

export const DashboardListSchema = z.array(DashboardListItemSchema);

export const DashboardSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    title: z.string(),
    dateCreated: z.string(),
    createdBy: z.unknown().nullable().optional(),
    widgets: z.array(DashboardWidgetSchema),
    projects: z.array(z.number()).default([]),
    environment: z.array(z.string()).default([]),
    filters: DashboardFiltersSchema.default({}),
    permissions: DashboardPermissionsSchema.nullable().optional(),
    isFavorited: z.boolean().optional(),
    prebuiltId: z.union([z.string(), z.number()]).nullable().optional(),
    period: z.string().nullable().optional(),
    start: z.string().nullable().optional(),
    end: z.string().nullable().optional(),
    utc: z.union([z.string(), z.boolean()]).nullable().optional(),
    expired: z.boolean().optional(),
  })
  .passthrough();

export const AlertRuleComponentSchema = z.record(z.string(), z.unknown());

export const IssueAlertRuleSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    name: z.string(),
    status: z.string().optional(),
    enabled: z.boolean().optional(),
    actionMatch: z.string().nullable().optional(),
    filterMatch: z.string().nullable().optional(),
    conditions: z.array(AlertRuleComponentSchema).optional().default([]),
    filters: z.array(AlertRuleComponentSchema).optional().default([]),
    actions: z.array(AlertRuleComponentSchema).optional().default([]),
    triggers: AlertRuleComponentSchema.nullable().optional(),
    actionFilters: z
      .array(AlertRuleComponentSchema)
      .nullable()
      .optional()
      .default([]),
    detectorIds: z
      .array(z.union([z.string(), z.number()]))
      .nullable()
      .optional()
      .default([]),
    config: z.record(z.string(), z.unknown()).optional().default({}),
    frequency: z.number().nullable().optional(),
    environment: z.string().nullable().optional(),
    owner: z.unknown().optional(),
    dateCreated: z.string().optional(),
    dateUpdated: z.string().optional(),
    lastTriggered: z.string().nullable().optional(),
  })
  .passthrough();

export const IssueAlertRuleListSchema = z.array(IssueAlertRuleSchema);

export const AlertRuleProjectScopeSchema = z.object({
  projectIds: z.array(z.string()),
  includesAllProjects: z.boolean(),
});

export const AlertActionOptionSchema = z.object({
  type: z.string(),
  handlerGroup: z.string(),
  configSchema: z.record(z.string(), z.unknown()),
  dataSchema: z.record(z.string(), z.unknown()),
  integrations: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        services: z
          .array(z.object({ id: z.string(), name: z.string() }))
          .optional(),
      }),
    )
    .optional(),
  services: z
    .array(z.object({ slug: z.string(), name: z.string() }))
    .optional(),
  sentryApp: z
    .object({
      id: z.string(),
      name: z.string(),
      installationId: z.string(),
      installationUuid: z.string(),
      status: z.string(),
      settings: z.record(z.string(), z.unknown()).optional(),
      title: z.string().optional(),
    })
    .optional(),
});

export const AlertConditionOptionSchema = z.object({
  type: z.string(),
  handlerGroup: z.string(),
  handlerSubgroup: z.string().optional(),
  comparisonJsonSchema: z.record(z.string(), z.unknown()),
});

// Source: workflow_engine/endpoints/serializers/detector_serializer.py.
// Configuration and data sources vary by detector type; preserve their native fields.
export const DetectorSchema = z
  .object({
    id: z.string(),
    projectId: z.string().nullable(),
    name: z.string(),
    type: z.string(),
    enabled: z.boolean(),
    config: z.record(z.string(), z.unknown()),
    conditionGroup: AlertRuleComponentSchema.nullable(),
    dataSources: z.array(AlertRuleComponentSchema).nullable(),
    workflowIds: z.array(z.string()).nullable(),
    description: z.string().nullable().optional(),
    owner: z.unknown().optional(),
    createdBy: z.string().nullable().optional(),
    dateCreated: z.string(),
    dateUpdated: z.string(),
    alertRuleId: z.number().nullable().optional(),
    ruleId: z.number().nullable().optional(),
  })
  .passthrough();

export const MetricAlertRuleSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    name: z.string(),
    status: z.union([z.string(), z.number()]).optional(),
    query: z.string().nullable().optional(),
    aggregate: z.string().nullable().optional(),
    dataset: z.string().nullable().optional(),
    timeWindow: z.number().nullable().optional(),
    environment: z.string().nullable().optional(),
    owner: z.unknown().optional(),
    projects: z.array(z.string()).optional().default([]),
    triggers: z.array(AlertRuleComponentSchema).optional().default([]),
    dateCreated: z.string().optional(),
  })
  .passthrough();

export const MetricAlertRuleListSchema = z.array(MetricAlertRuleSchema);

const ReplayTagsSchema = z.preprocess(
  (value) => {
    if (value === undefined || value === null || Array.isArray(value)) {
      return {};
    }
    return value;
  },
  z.record(z.string(), z.array(z.string())),
);

/**
 * Replay responses are normalized in getsentry/sentry before they hit this API.
 *
 * Upstream source of truth in getsentry/sentry:
 * - `src/sentry/replays/post_process.py` (`ReplayDetailsResponse`)
 * - `src/sentry/replays/endpoints/organization_replay_index.py`
 * - `src/sentry/replays/endpoints/organization_replay_details.py`
 */
export const ReplayDetailsSchema = z
  .object({
    activity: z.number().nullable().optional(),
    browser: z
      .object({
        name: z.string().nullable().optional(),
        version: z.string().nullable().optional(),
      })
      .nullish()
      .default({}),
    count_dead_clicks: z.number().nullable().optional(),
    count_errors: z.number().nullable().optional(),
    count_infos: z.number().nullable().optional(),
    count_rage_clicks: z.number().nullable().optional(),
    count_segments: z.number().nullable().optional(),
    count_urls: z.number().nullable().optional(),
    count_warnings: z.number().nullable().optional(),
    device: z
      .object({
        brand: z.string().nullable().optional(),
        family: z.string().nullable().optional(),
        model: z.string().nullable().optional(),
        model_id: z.string().nullable().optional(),
        name: z.string().nullable().optional(),
      })
      .nullish()
      .default({}),
    dist: z.string().nullable().optional(),
    duration: z.number().nullable().optional(),
    environment: z.string().nullable().optional(),
    error_ids: z.array(z.string()).optional().default([]),
    finished_at: z.string().nullable().optional(),
    has_viewed: z.boolean().nullable().optional(),
    id: z.string(),
    info_ids: z.array(z.string()).optional().default([]),
    is_archived: z.boolean().nullable().optional(),
    os: z
      .object({
        name: z.string().nullable().optional(),
        version: z.string().nullable().optional(),
      })
      .nullish()
      .default({}),
    platform: z.string().nullable().optional(),
    project_id: z.union([z.string(), z.number()]).nullable().optional(),
    releases: z.array(z.string()).nullable().optional(),
    replay_type: z.string().nullable().optional(),
    sdk: z
      .object({
        name: z.string().nullable().optional(),
        version: z.string().nullable().optional(),
      })
      .nullish()
      .default({}),
    started_at: z.string().nullable().optional(),
    tags: ReplayTagsSchema,
    trace_ids: z.array(z.string()).optional().default([]),
    urls: z.preprocess((value) => value ?? [], z.array(z.string())),
    user: z
      .object({
        display_name: z.string().nullable().optional(),
        email: z.string().nullable().optional(),
        id: z.string().nullable().optional(),
        ip: z.string().nullable().optional(),
        username: z.string().nullable().optional(),
        geo: z.record(z.string(), z.union([z.string(), z.null()])).optional(),
      })
      .nullish()
      .default({}),
    warning_ids: z.array(z.string()).optional().default([]),
  })
  .passthrough();

const ReplayRecordingPayloadSchema = z
  .object({
    op: z.string().optional().catch(undefined),
    description: z.string().optional().catch(undefined),
    message: z.string().optional().catch(undefined),
    category: z.string().optional().catch(undefined),
    type: z.string().optional().catch(undefined),
    data: z
      .object({
        duration: z.number().optional().catch(undefined),
      })
      .passthrough()
      .optional()
      .catch(undefined),
  })
  .passthrough();

export const ReplayRecordingEventSchema = z
  .object({
    timestamp: z.number().optional().catch(undefined),
    type: z.number().optional().catch(undefined),
    data: z
      .object({
        tag: z.string().optional().catch(undefined),
        href: z.string().optional().catch(undefined),
        payload: ReplayRecordingPayloadSchema.optional().catch(undefined),
      })
      .passthrough()
      .optional()
      .catch(undefined),
  })
  .passthrough();

export const ReplayRecordingSegmentsSchema = z.array(
  z.array(z.unknown()).transform((events) =>
    events.flatMap((event) => {
      const result = ReplayRecordingEventSchema.safeParse(event);
      return result.success ? [result.data] : [];
    }),
  ),
);

export const ReplayListResponseSchema = z.object({
  data: z.array(ReplayDetailsSchema),
});

export const ReplayIdsByResourceSchema = z.record(
  z.string(),
  z.array(z.string()),
);

export const ClientKeySchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    name: z.string(),
    dsn: z
      .object({
        public: z.string(),
      })
      .passthrough(),
    isActive: z.boolean(),
    dateCreated: z.string().datetime().nullable(),
    rateLimit: z
      .object({
        window: z.number(),
        count: z.number(),
      })
      .nullable()
      .optional(),
    browserSdkVersion: z.string().optional(),
    dynamicSdkLoaderOptions: z
      .object({
        hasReplay: z.boolean(),
        hasPerformance: z.boolean(),
        hasDebug: z.boolean(),
        hasFeedback: z.boolean().optional(),
        hasLogsAndMetrics: z.boolean().optional(),
      })
      .optional(),
  })
  .passthrough();

export const ClientKeyListSchema = z.array(ClientKeySchema);

const ReleaseProjectSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    slug: z.string().nullable(),
    name: z.string(),
    platform: z.string().nullable().optional(),
  })
  .passthrough();

const ReleaseCommitAuthorSchema = z
  .object({
    name: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * Local subset of both organization-wide and project-scoped release payloads.
 *
 * Upstream source of truth in getsentry/sentry:
 * - `src/sentry/api/endpoints/organization_releases.py`
 * - `src/sentry/releases/endpoints/project_releases.py`
 * - `src/sentry/api/serializers/models/release.py`
 * - `src/sentry/api/serializers/rest_framework/release.py`
 */
export const ReleaseSchema = z.object({
  id: z.union([z.string(), z.number()]),
  version: z.string(),
  shortVersion: z.string(),
  dateCreated: z.string().datetime(),
  dateReleased: z.string().datetime().nullable(),
  firstEvent: z.string().datetime().nullable(),
  lastEvent: z.string().datetime().nullable(),
  newGroups: z.number(),
  lastCommit: z
    .object({
      id: z.union([z.string(), z.number()]),
      message: z.string().nullable(),
      dateCreated: z.string().datetime(),
      author: ReleaseCommitAuthorSchema.optional(),
    })
    .passthrough()
    .nullable(),
  lastDeploy: z
    .object({
      id: z.union([z.string(), z.number()]),
      environment: z.string().nullable(),
      dateStarted: z.string().datetime().nullable(),
      dateFinished: z.string().datetime().nullable(),
    })
    .passthrough()
    .nullable(),
  projects: z.array(ReleaseProjectSchema),
});

export const ReleaseListSchema = z.array(ReleaseSchema);

const ApiResourceIdSchema = z.union([z.string(), z.number()]);

const ApiActorSchema = z
  .object({
    id: ApiResourceIdSchema.optional(),
    name: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    username: z.string().nullable().optional(),
    type: z.string().nullable().optional(),
  })
  .passthrough();

const ApiProjectRefSchema = z
  .object({
    id: ApiResourceIdSchema.optional(),
    slug: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
  })
  .passthrough();

export const MonitorEnvironmentSchema = z
  .object({
    id: ApiResourceIdSchema.optional(),
    name: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    dateCreated: z.string().datetime().nullable().optional(),
    lastCheckIn: z.string().datetime().nullable().optional(),
    nextCheckIn: z.string().datetime().nullable().optional(),
    nextCheckInLatest: z.string().datetime().nullable().optional(),
    isMuted: z.boolean().nullable().optional(),
    activeIncident: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .passthrough();

export const MonitorSchema = z
  .object({
    id: ApiResourceIdSchema.optional(),
    slug: z.string(),
    name: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    type: z.string().nullable().optional(),
    isMuted: z.boolean().nullable().optional(),
    isUpserting: z.boolean().nullable().optional(),
    project: ApiProjectRefSchema.nullable().optional(),
    owner: z.union([z.string(), ApiActorSchema]).nullable().optional(),
    dateCreated: z.string().datetime().nullable().optional(),
    nextCheckIn: z.string().datetime().nullable().optional(),
    lastCheckIn: z.string().datetime().nullable().optional(),
    config: z.record(z.string(), z.unknown()).nullable().optional(),
    environments: z.array(MonitorEnvironmentSchema).optional(),
    alertRule: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const MonitorListSchema = z.array(MonitorSchema);

export const MonitorCheckInSchema = z
  .object({
    id: ApiResourceIdSchema.optional(),
    checkInId: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    duration: z.number().nullable().optional(),
    dateCreated: z.string().datetime().nullable().optional(),
    dateAdded: z.string().datetime().nullable().optional(),
    dateUpdated: z.string().datetime().nullable().optional(),
    dateInProgress: z.string().datetime().nullable().optional(),
    dateClock: z.string().datetime().nullable().optional(),
    expectedTime: z.string().datetime().nullable().optional(),
    environment: z.string().nullable().optional(),
    monitorConfig: z.record(z.string(), z.unknown()).optional(),
    groups: z
      .array(z.union([z.string(), z.record(z.string(), z.unknown())]))
      .optional(),
  })
  .passthrough();

export const MonitorCheckInListSchema = z.array(MonitorCheckInSchema);

export const MonitorStatSchema = z
  .object({
    ts: z.number(),
  })
  .passthrough();

export const MonitorStatsSchema = z.array(MonitorStatSchema);

/**
 * Uptime monitor (detector) schemas.
 *
 * Verified against getsentry/sentry:
 * - src/sentry/uptime/endpoints/serializers.py (UptimeDetectorSerializer)
 * - src/sentry/uptime/endpoints/validators.py (UptimeMonitorValidator)
 * - src/sentry/uptime/models.py (IntervalSeconds, SupportedHTTPMethods)
 * Response fields are camelCase from CamelSnakeSerializer.
 */
export const UptimeMonitorSchema = z
  .object({
    id: ApiResourceIdSchema,
    projectSlug: z.string(),
    environment: z.string().nullable().optional(),
    name: z.string(),
    status: z.string(),
    uptimeStatus: z.union([z.number(), z.string()]).optional(),
    mode: z.number().optional(),
    owner: ApiActorSchema.nullable().optional(),
    recoveryThreshold: z.number().optional(),
    downtimeThreshold: z.number().optional(),
    url: z.string(),
    method: z.string().optional(),
    body: z.string().nullable().optional(),
    headers: z
      .array(z.tuple([z.string(), z.string()]))
      .or(z.array(z.array(z.string())))
      .optional(),
    intervalSeconds: z.number(),
    timeoutMs: z.number(),
    traceSampling: z.boolean().optional(),
    responseCaptureEnabled: z.boolean().optional(),
    assertion: z.unknown().nullable().optional(),
  })
  .passthrough();

export const UptimeMonitorListSchema = z.array(UptimeMonitorSchema);

export const UptimeCheckSchema = z
  .object({
    uptimeCheckId: z.string().optional(),
    timestamp: z.string().optional(),
    scheduledCheckTime: z.string().optional(),
    checkStatus: z.string().optional(),
    checkStatusReason: z.string().nullable().optional(),
    assertionFailureData: z.unknown().nullable().optional(),
    httpStatusCode: z.number().nullable().optional(),
    durationMs: z.number().optional(),
    traceId: z.string().optional(),
    traceItemId: z.string().optional(),
    incidentStatus: z.number().optional(),
    environment: z.string().optional(),
    region: z.string().optional(),
    regionName: z.string().optional(),
  })
  .passthrough();

export const UptimeCheckListSchema = z.array(UptimeCheckSchema);

export const ReleaseDetailsSchema = ReleaseSchema.extend({
  adoptionStages: z.unknown().optional(),
  authors: z.array(ApiActorSchema).optional(),
  commitCount: z.number().optional(),
  currentProjectMeta: z.record(z.string(), z.unknown()).optional(),
  deployCount: z.number().optional(),
  lastDeploy: ReleaseSchema.shape.lastDeploy.optional(),
  newGroups: z.number().optional(),
  owner: ApiActorSchema.nullable().optional(),
  projects: z.array(ReleaseProjectSchema).optional(),
  refs: z.array(z.record(z.string(), z.unknown())).optional(),
})
  .partial()
  .extend({
    id: ApiResourceIdSchema,
    version: z.string(),
  })
  .passthrough();

export const DeploySchema = z
  .object({
    id: ApiResourceIdSchema,
    environment: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    dateStarted: z.string().datetime().nullable().optional(),
    dateFinished: z.string().datetime().nullable().optional(),
  })
  .passthrough();

export const DeployListSchema = z.array(DeploySchema);

export const CommitSchema = z
  .object({
    id: ApiResourceIdSchema,
    message: z.string().nullable().optional(),
    dateCreated: z.string().datetime().nullable().optional(),
    pullRequest: z.record(z.string(), z.unknown()).nullable().optional(),
    // The event committers endpoint populates this; release commits usually return an empty string.
    suspectCommitType: z.string().optional(),
    author: ApiActorSchema.nullable().optional(),
    repository: z
      .object({
        name: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export const CommitListSchema = z.array(CommitSchema);

export const CommitterSchema = z
  .object({
    author: ApiActorSchema.nullable().optional(),
    commits: CommitListSchema,
  })
  .passthrough();

export const CommittersResponseSchema = z.object({
  committers: z.array(CommitterSchema),
});

export const IssueActivitySchema = z
  .object({
    id: ApiResourceIdSchema,
    type: z.string().nullable().optional(),
    dateCreated: z.string().datetime().nullable().optional(),
    user: ApiActorSchema.nullable().optional(),
    sentry_app: z.record(z.string(), z.unknown()).nullable().optional(),
    data: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .passthrough();

export const IssueActivityListResponseSchema = z.object({
  activity: z.array(IssueActivitySchema),
});

export const IssueCommentSchema = IssueActivitySchema.extend({
  type: z.string().nullable().optional(),
});

export const IssueCommentListSchema = z.array(IssueCommentSchema);

/**
 * Organization tag lists are backed by `TagKeySerializerResponse`, which only
 * guarantees `key` and `name`. Count fields are backend-dependent and may come
 * back as `uniqueValues`, `totalValues`, or neither.
 *
 * Upstream source of truth in getsentry/sentry:
 * - `src/sentry/tagstore/types.py` (`TagKeySerializerResponse`)
 * - `src/sentry/api/endpoints/organization_tags.py`
 */
export const TagSchema = z
  .object({
    key: z.string(),
    name: z.string(),
    totalValues: z.number().nullable().optional(),
    uniqueValues: z.number().nullable().optional(),
  })
  .transform((tag) => ({
    key: tag.key,
    name: tag.name,
    totalValues: tag.totalValues ?? tag.uniqueValues ?? 0,
  }));

export const TagListSchema = z.array(TagSchema);

// Schema for assignedTo field - can be a user object, team object, string, or null
export const AssignedToSchema = z.union([
  z.null(),
  z.string(), // username or actor ID
  z
    .object({
      type: z.enum(["user", "team"]),
      id: z.union([z.string(), z.number()]),
      name: z.string(),
      email: z.string().optional(), // only for users
    })
    .passthrough(), // Allow additional fields we might not know about
]);

/**
 * Local subset shared by issue list and issue details payloads.
 *
 * Upstream source of truth in getsentry/sentry:
 * - `src/sentry/api/serializers/models/group.py` (`BaseGroupSerializerResponse`)
 * - `src/sentry/api/serializers/models/group_stream.py` (`StreamGroupSerializerResponse`)
 * - `src/sentry/issues/endpoints/group_details.py`
 *
 * In particular, `culprit` is nullable upstream.
 */
export const IssueSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    shortId: z.string().nullable(),
    title: z.string(),
    firstSeen: z.string().datetime().nullable(),
    lastSeen: z.string().datetime().nullable(),
    count: z.union([z.string(), z.number()]),
    userCount: z.union([z.string(), z.number()]),
    permalink: z.string().url(),
    project: ProjectSchema,
    platform: z.string().nullable().optional(),
    status: z.string(),
    substatus: z.string().nullable().optional(),
    culprit: z.string().nullable(),
    type: z
      .union([
        z.literal("error"),
        z.literal("transaction"),
        z.literal("generic"),
        z.unknown(),
      ])
      .optional(),
    assignedTo: AssignedToSchema.optional(),
    issueType: z.string().optional(),
    issueCategory: z.string().optional(),
    metadata: z
      .object({
        title: z.string().nullable().optional(),
        location: z.string().nullable().optional(),
        value: z.string().nullable().optional(),
      })
      .optional(),
    seerFixabilityScore: z.number().nullable().optional(),
  })
  .passthrough()
  .transform((issue) =>
    Object.assign(issue, { shortId: issue.shortId ?? String(issue.id) }),
  );

export const IssueListSchema = z.array(IssueSchema);

export const FrameInterface = z
  .object({
    filename: z.string().nullable(),
    function: z.string().nullable(),
    lineNo: z.number().nullable(),
    colNo: z.number().nullable(),
    absPath: z.string().nullable(),
    module: z.string().nullable(),
    package: z.string().nullable(),
    platform: z.string().nullable(),
    sourceLink: z.string().nullable(),
    // lineno, source code
    context: z.array(z.tuple([z.number(), z.string()])),
    inApp: z.boolean().optional(),
    vars: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .partial();

// XXX: Sentry's schema generally speaking is "assume all user input is missing"
// so we need to handle effectively every field being optional or nullable.
export const ExceptionInterface = z
  .object({
    mechanism: z
      .object({
        type: z.string().nullable(),
        handled: z.boolean().nullable(),
      })
      .partial()
      .nullable(),
    type: z.string().nullable(),
    value: z.string().nullable(),
    stacktrace: z
      .object({
        frames: z.array(FrameInterface),
      })
      .nullable(),
  })
  .partial();

export const ErrorEntrySchema = z
  .object({
    // XXX: Sentry can return either of these. Not sure why we never normalized it.
    values: z.array(ExceptionInterface.optional()),
    value: ExceptionInterface.nullable().optional(),
  })
  .partial();

export const RequestEntrySchema = z
  .object({
    method: z.string().nullable(),
    url: z.string().url().nullable(),
    // TODO:
    // query: z.array(z.tuple([z.string(), z.string()])).nullable(),
    // data: z.unknown().nullable(),
    // headers: z.array(z.tuple([z.string(), z.string()])).nullable(),
  })
  .partial();

export const MessageEntrySchema = z
  .object({
    formatted: z.string().nullable(),
    message: z.string().nullable(),
    params: z.array(z.unknown()).optional(),
  })
  .partial();

const StacktraceSchema = z
  .object({
    frames: z.array(FrameInterface),
    framesOmitted: z.array(z.unknown()).nullable().optional(),
    registers: z.record(z.string(), z.unknown()).nullable().optional(),
    hasSystemFrames: z.boolean().nullable().optional(),
  })
  .partial()
  .extend({
    frames: z.array(FrameInterface),
  });

export const ThreadEntrySchema = z
  .object({
    id: z.union([z.number(), z.string()]).nullable(),
    name: z.string().nullable(),
    current: z.boolean().nullable(),
    crashed: z.boolean().nullable(),
    state: z.string().nullable(),
    heldLocks: z.record(z.string(), z.unknown()).nullable().optional(),
    stacktrace: StacktraceSchema.nullable(),
    rawStacktrace: StacktraceSchema.nullable().optional(),
  })
  .partial();

export const ThreadsEntrySchema = z
  .object({
    values: z.array(ThreadEntrySchema),
  })
  .partial();

export const BreadcrumbSchema = z
  .object({
    timestamp: z.string().nullable(),
    type: z.string().nullable(),
    category: z.string().nullable(),
    level: z.string().nullable(),
    message: z.string().nullable(),
    data: z.record(z.string(), z.unknown()).nullable(),
  })
  .partial();

export const BreadcrumbsEntrySchema = z
  .object({
    values: z.array(BreadcrumbSchema),
  })
  .partial();

const EventTagSchema = z.object({
  key: z.string(),
  value: z.string().nullable(),
});

const EventTagsSchema = z.preprocess((value) => {
  if (!Array.isArray(value)) {
    return value;
  }

  // Sentry can occasionally return malformed tag entries (e.g. null keys).
  // Drop invalid tags so event parsing can still succeed.
  return value.filter((tag) => {
    if (typeof tag !== "object" || tag === null) {
      return false;
    }

    const maybeTag = tag as { key?: unknown; value?: unknown };
    const hasValidKey = typeof maybeTag.key === "string";
    const hasValidValue =
      typeof maybeTag.value === "string" || maybeTag.value === null;

    return hasValidKey && hasValidValue;
  });
}, z.array(EventTagSchema));

const BaseEventSchema = z.object({
  id: z.string(),
  groupID: z.string().nullable().optional(),
  title: z.string(),
  message: z.string().nullable(),
  platform: z.string().nullable().optional(),
  type: z.unknown(),
  entries: z.array(
    z.union([
      z.object({
        type: z.literal("exception"),
        data: ErrorEntrySchema,
      }),
      z.object({
        type: z.literal("message"),
        data: MessageEntrySchema,
      }),
      z.object({
        type: z.literal("threads"),
        data: ThreadsEntrySchema,
      }),
      z.object({
        type: z.literal("request"),
        data: RequestEntrySchema,
      }),
      z.object({
        type: z.literal("breadcrumbs"),
        data: BreadcrumbsEntrySchema,
      }),
      z.object({
        type: z.literal("spans"),
        data: z.unknown(),
      }),
      z.object({
        type: z.string(),
        data: z.unknown(),
      }),
    ]),
  ),
  contexts: z
    .record(
      z.string(),
      z
        .object({
          type: z
            .union([
              z.literal("default"),
              z.literal("runtime"),
              z.literal("os"),
              z.literal("trace"),
              z.unknown(),
            ])
            .optional(),
        })
        .passthrough(),
    )
    .optional(),
  // "context" (singular) is the legacy "extra" field for arbitrary user-defined data
  // This is different from "contexts" (plural) which are structured contexts
  // Sentry preserves null when the event's extra data is explicitly null.
  context: z.record(z.string(), z.unknown()).nullable().optional(),
  sdk: z
    .object({
      name: z.string().nullable().optional(),
    })
    .passthrough()
    .nullable()
    .optional(),
  release: z
    .object({
      lastCommit: z
        .object({
          id: z.string(),
        })
        .passthrough()
        .nullable()
        .optional(),
    })
    .passthrough()
    .nullable()
    .optional(),
  tags: EventTagsSchema.optional(),
  user: z
    .object({
      display_name: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
      id: z.string().nullable().optional(),
      ip: z.string().nullable().optional(),
      ip_address: z.string().nullable().optional(),
      name: z.string().nullable().optional(),
      username: z.string().nullable().optional(),
      geo: z
        .record(z.string(), z.union([z.string(), z.null()]))
        .nullable()
        .optional(),
    })
    .passthrough()
    .nullable()
    .optional(),
  // The _meta field contains metadata about fields in the response
  // It's safer to type as unknown since its structure varies
  _meta: z.unknown().optional(),
  // dateReceived is when the server received the event (may not be present in all contexts)
  dateReceived: z.string().datetime().nullish(),
  // shared-formatter output, present when the event endpoint is called with ?llmFormat
  formatted: z.object({ format: z.string(), content: z.string() }).optional(),
});

export const ErrorEventSchema = BaseEventSchema.omit({
  type: true,
}).extend({
  type: z.literal("error"),
  culprit: z.string().nullable(),
  dateCreated: z.string().datetime(),
});

export const DefaultEventSchema = BaseEventSchema.omit({
  type: true,
}).extend({
  type: z.literal("default"),
  culprit: z.string().nullable().optional(),
  dateCreated: z.string().datetime(),
});

export const TransactionEventSchema = BaseEventSchema.omit({
  type: true,
}).extend({
  type: z.literal("transaction"),
  occurrence: z
    .object({
      id: z.string().optional(),
      projectId: z.number().optional(),
      eventId: z.string().optional(),
      fingerprint: z.array(z.string()).optional(),
      issueTitle: z.string(),
      subtitle: z.string().optional(),
      resourceId: z.string().nullable().optional(),
      evidenceData: z.record(z.string(), z.any()).optional(),
      evidenceDisplay: z
        .array(
          z.object({
            name: z.string(),
            value: z.string(),
            important: z.boolean().optional(),
          }),
        )
        .optional(),
      type: z.number().optional(),
      detectionTime: z.number().optional(),
      level: z.string().optional(),
      culprit: z.string().nullable(),
      priority: z.number().optional(),
      assignee: z.string().nullable().optional(),
    })
    .nullish(), // Allow both null and undefined
});

/**
 * Schema for evidence display items in occurrence data.
 * These show regression details, metric changes, and other evidence.
 */
export const EvidenceDisplaySchema = z.object({
  name: z.string(),
  value: z.string(),
  important: z.boolean(),
});

/**
 * Schema for occurrence data in generic events.
 * Occurrences represent performance regressions and metric-based issues.
 */
export const OccurrenceSchema = z
  .object({
    id: z.string(),
    projectId: z.number(),
    eventId: z.string(),
    fingerprint: z.array(z.string()),
    issueTitle: z.string(),
    subtitle: z.string().optional(),
    resourceId: z.string().nullable().optional(),
    evidenceData: z.record(z.string(), z.unknown()).optional(),
    evidenceDisplay: z.array(EvidenceDisplaySchema).optional(),
    type: z.number(),
    detectionTime: z.number().optional(),
    level: z.string().optional(),
    culprit: z.string().optional(),
    priority: z.number().optional(),
    assignee: z.string().nullable().optional(),
  })
  .passthrough();

export const GenericEventSchema = BaseEventSchema.omit({
  type: true,
}).extend({
  type: z.literal("generic"),
  culprit: z.string().nullable().optional(),
  dateCreated: z.string().datetime(),
  occurrence: OccurrenceSchema.nullish(),
});

export const UnknownEventSchema = BaseEventSchema.omit({
  type: true,
}).extend({
  type: z.unknown(),
});

// XXX: This API response is kind of a disaster. We are not propagating the appropriate
// columns and it makes this really hard to work with. Errors and Transaction-based issues
// are completely different, for example.
export const EventSchema = z.union([
  ErrorEventSchema,
  DefaultEventSchema,
  TransactionEventSchema,
  GenericEventSchema,
  UnknownEventSchema,
]);

export const StacktraceLinkSchema = z
  .object({
    config: z
      .object({
        repoName: z.string(),
      })
      .passthrough()
      .nullable()
      .optional(),
    sourcePath: z.string().nullable().optional(),
    sourceUrl: z.string().nullable().optional(),
  })
  .passthrough();

export const EventsResponseSchema = z.object({
  data: z.array(z.unknown()),
  meta: z
    .object({
      fields: z.record(z.string(), z.string()),
    })
    .passthrough(),
});

// https://us.sentry.io/api/0/organizations/sentry/events/?dataset=errors&field=issue&field=title&field=project&field=timestamp&field=trace&per_page=5&query=event.type%3Aerror&referrer=api.mcp.search-events&sort=-timestamp&statsPeriod=1w
export const ErrorsSearchResponseSchema = EventsResponseSchema.extend({
  data: z.array(
    z.object({
      issue: z.string(),
      "issue.id": z.union([z.string(), z.number()]),
      project: z.string(),
      title: z.string(),
      "count()": z.number(),
      "last_seen()": z.string(),
    }),
  ),
});

export const SpansSearchResponseSchema = EventsResponseSchema.extend({
  data: z.array(
    z.object({
      id: z.string(),
      trace: z.string(),
      "span.op": z.string(),
      "span.description": z.string(),
      "span.duration": z.number(),
      transaction: z.string(),
      project: z.string(),
      timestamp: z.string(),
    }),
  ),
});

/**
 * The Seer autofix POST endpoint currently returns a simple numeric `run_id`.
 *
 * Upstream source of truth in getsentry/sentry:
 * - `src/sentry/seer/endpoints/group_ai_autofix.py`
 * - `src/sentry/seer/autofix/types.py` (`AutofixPostResponse`)
 */
export const AutofixRunSchema = z
  .object({
    run_id: z.number(),
  })
  .passthrough();

// Run statuses from Sentry's `SeerRunState` (`seer/agent/client_models.py`).
const AutofixStatusSchema = z.enum([
  "processing",
  "completed",
  "error",
  "awaiting_user_input",
]);

const AutofixArtifactSchema = z
  .object({
    key: z.string(),
    data: z.record(z.string(), z.unknown()).nullable().default(null),
  })
  .passthrough();

const AutofixTodoSchema = z
  .object({
    content: z.string(),
    status: z.string(),
  })
  .passthrough();

// Agent memory blocks (Sentry's `MemoryBlock`). Analysis content arrives as
// artifacts keyed "root_cause" and "solution"; only what we render is modeled.
const AutofixBlockSchema = z
  .object({
    artifacts: z.array(AutofixArtifactSchema).default([]),
    todos: z.array(AutofixTodoSchema).nullable().optional(),
  })
  .passthrough();

/**
 * The Seer autofix GET endpoint is explicitly experimental. It returns the
 * agent-based run state (`blocks`, `pending_user_input`, coding-agent
 * metadata).
 *
 * Upstream source of truth in getsentry/sentry:
 * - `src/sentry/seer/endpoints/group_ai_autofix.py`
 * - `src/sentry/seer/agent/client_models.py` (`SeerRunState`)
 */
export const AutofixRunStateSchema = z.object({
  autofix: z
    .object({
      run_id: z.number(),
      updated_at: z.string().nullable().optional(),
      status: AutofixStatusSchema,
      blocks: z.array(AutofixBlockSchema).default([]),
      pending_user_input: z.unknown().nullable().optional(),
      repo_pr_states: z
        .record(
          z.string(),
          z.object({ pr_url: z.string().nullable().optional() }).passthrough(),
        )
        .optional(),
      coding_agents: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough()
    .nullable(),
  // shared-formatter output, present when the autofix endpoint is called with ?llmFormat
  formatted: z.object({ format: z.string(), content: z.string() }).optional(),
});

/**
 * Schemas for Seer's search agent, which translates natural language into
 * Sentry search queries.
 *
 * Upstream source of truth in getsentry/sentry:
 * - `src/sentry/seer/endpoints/search_agent_start.py`
 * - `src/sentry/seer/endpoints/search_agent_state.py`
 * - `src/sentry/seer/endpoints/search_agent_types.py`
 */
export const SearchAgentStartSchema = z
  .object({
    // Null until Seer has picked up the run; poll with sentry_run_id instead.
    run_id: z.number().nullable(),
    sentry_run_id: z.string(),
  })
  .passthrough();

export const SearchAgentQuerySchema = z
  .object({
    query: z.string(),
    group_by: z.array(z.string()).default([]),
    visualization: z
      .array(
        z
          .object({
            y_axes: z.array(z.string()).default([]),
            // Only set when the user asks for a time bucket, e.g. "per hour".
            interval: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .default([]),
    sort: z.string().default(""),
    // Empty when an absolute start/end range is used instead.
    stats_period: z.string().default(""),
    start: z.string().nullable().optional(),
    end: z.string().nullable().optional(),
    mode: z.string(),
    // Cross-event filters, only set for the Traces strategy.
    span_query: z.string().nullable().optional(),
    log_query: z.string().nullable().optional(),
    metric_query: z.string().nullable().optional(),
  })
  .passthrough();

export const SearchAgentTranslateSchema = z
  .object({
    responses: z.array(SearchAgentQuerySchema),
    unsupported_reason: z.string().nullable().optional(),
    // Projects Seer scoped the query to, a superset of the requested projects
    // when it broadens scope. Absent when there's no expansion.
    project_ids: z.array(z.number()).nullable().optional(),
  })
  .passthrough();

export const SearchAgentStateSchema = z
  .object({
    session: z
      .object({
        // Only `status` is set while the run is still being created in Seer.
        status: z.string(),
        final_response: SearchAgentTranslateSchema.nullable().optional(),
        unsupported_reason: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable(),
  })
  .passthrough();

export const EventAttachmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  size: z.number(),
  mimetype: z.string(),
  dateCreated: z.string().datetime(),
  // Objectstore-backed attachments do not store a usable SHA1 (checksum is
  // unavailable), so we neither require nor surface it from this endpoint.
  headers: z.record(z.string(), z.string()).optional(),
});

export const EventAttachmentListSchema = z.array(EventAttachmentSchema);

// GET /organizations/{org}/environments/ — visible environments (the endpoint
// excludes the empty-name "No Environment" and hidden environments by default).
export const OrganizationEnvironmentSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export const OrganizationEnvironmentListSchema = z.array(
  OrganizationEnvironmentSchema,
);

/**
 * Schema for individual tag values within an issue's tag distribution.
 *
 * Represents a single value's occurrence count and percentage within a tag.
 */
export const IssueTagValueSchema = z.object({
  key: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  value: z.string().nullable(),
  count: z
    .number()
    .nullable()
    .transform((value) => value ?? 0),
  lastSeen: z.string().datetime().nullable().optional(),
  firstSeen: z.string().datetime().nullable().optional(),
});

/**
 * Schema for Sentry issue tag values response.
 *
 * Contains aggregate counts of unique tag values for an issue,
 * useful for understanding the distribution of tags like URL, browser, etc.
 *
 * Upstream source of truth in getsentry/sentry:
 * - `src/sentry/tagstore/types.py` (`TagKeySerializerResponse`,
 *   `TagValueSerializerResponse`)
 * - `src/sentry/issues/endpoints/group_tagkey_details.py`
 */
export const IssueTagValuesSchema = z
  .object({
    key: z.string(),
    name: z.string(),
    totalValues: z.number().nullable().optional(),
    uniqueValues: z.number().nullable().optional(),
    topValues: z.array(IssueTagValueSchema).nullable().optional(),
  })
  .transform((tagValues) => ({
    key: tagValues.key,
    name: tagValues.name,
    totalValues: tagValues.totalValues ?? tagValues.uniqueValues ?? 0,
    topValues: tagValues.topValues ?? [],
  }));

/**
 * Schema for external issue link (e.g., Jira, GitHub Issues).
 *
 * Represents a link between a Sentry issue and an external issue tracking
 * system like Jira, GitHub Issues, GitLab, etc.
 */
export const ExternalIssueSchema = z.object({
  id: z.union([z.string(), z.number()]),
  issueId: z.union([z.string(), z.number()]),
  serviceType: z.string(),
  displayName: z.string(),
  webUrl: z.string(),
});

export const UserReportSchema = z.object({
  id: z.string(),
  eventID: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  comments: z.string(),
  dateCreated: z.string(),
  user: z
    .object({
      id: z.string(),
      username: z.string().nullable(),
      email: z.string().nullable(),
      name: z.string().nullable(),
      ipAddress: z.string().nullable(),
      avatarUrl: z.string().nullable(),
    })
    .nullable(),
  event: z.object({
    id: z.string(),
    eventID: z.string(),
  }),
});

export const UserReportListSchema = z.array(UserReportSchema);

export const ExternalIssueListSchema = z.array(ExternalIssueSchema);

export const IntegrationProviderSchema = z
  .object({
    key: z.string(),
    slug: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();

export const IssueIntegrationExternalIssueSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    key: z.string(),
    url: z.string().optional(),
    title: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    displayName: z.string().optional(),
  })
  .passthrough();

export const IssueIntegrationSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    name: z.string(),
    domainName: z.string().nullable().optional(),
    status: z.string().optional(),
    provider: IntegrationProviderSchema,
    externalIssues: z.array(IssueIntegrationExternalIssueSchema).default([]),
  })
  .passthrough();

export const IssueIntegrationListSchema = z.array(IssueIntegrationSchema);

export const NativeExternalIssueSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    key: z.string(),
    url: z.string().optional(),
    integrationId: z.union([z.string(), z.number()]).optional(),
    displayName: z.string().optional(),
  })
  .passthrough();

export const SentryAppInstallationSchema = z
  .object({
    uuid: z.string(),
    status: z.string().optional(),
    app: z
      .object({
        uuid: z.string().optional(),
        slug: z.string(),
        sentryAppId: z.number().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export const SentryAppInstallationListSchema = z.array(
  SentryAppInstallationSchema,
);

export const SentryAppComponentSchema = z.object({
  type: z.string(),
  sentryApp: z.object({ uuid: z.string(), slug: z.string() }),
  schema: z.record(z.string(), z.unknown()),
  error: z.unknown().optional(),
});
export const SentryAppComponentListSchema = z.array(SentryAppComponentSchema);

export const SentryAppExternalRequestOptionsSchema = z.object({
  choices: z.array(
    z.tuple([
      z.union([z.string(), z.number()]),
      z.union([z.string(), z.number()]),
    ]),
  ),
  defaultValue: z.union([z.string(), z.number()]).optional(),
});

/**
 * Schema for Sentry trace metadata response.
 *
 * Contains high-level statistics about a trace including span counts,
 * transaction breakdown, and operation type distribution.
 *
 * Upstream source of truth in getsentry/sentry:
 * - `src/sentry/api/endpoints/organization_trace_meta.py`
 */
const TraceMetaTransactionChildCountSchema = z.object({
  "transaction.event_id": z.string().nullable(),
  "count()": z.number(),
});

export const TraceMetaSchema = z
  .object({
    logs: z.number().optional(),
    errors: z.number().optional(),
    performance_issues: z.number().optional(),
    span_count: z.number().optional(),
    transaction_child_count_map: z
      .array(TraceMetaTransactionChildCountSchema)
      .optional(),
    span_count_map: z.record(z.string(), z.number()).optional(),
    logsCount: z.number().optional(),
    errorsCount: z.number().optional(),
    performanceIssuesCount: z.number().optional(),
    spansCount: z.number().optional(),
    transactionChildCountMap: z
      .array(TraceMetaTransactionChildCountSchema)
      .optional(),
    spansCountMap: z.record(z.string(), z.number()).optional(),
  })
  .transform((meta) => ({
    logs: meta.logs ?? meta.logsCount ?? 0,
    errors: meta.errors ?? meta.errorsCount ?? 0,
    performance_issues:
      meta.performance_issues ?? meta.performanceIssuesCount ?? 0,
    span_count: meta.span_count ?? meta.spansCount ?? 0,
    transaction_child_count_map:
      meta.transaction_child_count_map ?? meta.transactionChildCountMap ?? [],
    span_count_map: meta.span_count_map ?? meta.spansCountMap ?? {},
  }));

/**
 * Schema for individual spans within a trace.
 *
 * Represents the hierarchical structure of spans with timing information,
 * operation details, and nested children spans.
 */
export const TraceSpanSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    children: z.array(TraceSpanSchema),
    errors: z.array(z.any()),
    occurrences: z.array(z.any()),
    event_id: z.string(),
    span_id: z.string().optional(),
    transaction_id: z.string(),
    project_id: z.union([z.string(), z.number()]),
    project_slug: z.string(),
    profile_id: z.string().nullable().optional(),
    profiler_id: z.string().nullable().optional(),
    parent_span_id: z.string().nullable(),
    start_timestamp: z.number(),
    end_timestamp: z.number(),
    measurements: z.record(z.string(), z.number()).optional(),
    duration: z.number(),
    trace: z.string().optional(),
    transaction: z.string().nullable().optional(),
    is_transaction: z.boolean().optional(),
    description: z.string().nullable().optional(),
    sdk_name: z.string().nullable().optional(),
    op: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    event_type: z.string().nullable().optional(),
    additional_attributes: z.record(z.string(), z.unknown()).optional(),
    hash: z.string().nullable().optional(),
    exclusive_time: z.number().optional(),
    status: z.string().nullable().optional(),
    is_segment: z.boolean().optional(),
    same_process_as_parent: z.boolean().optional(),
    organization: z.unknown().nullable().optional(),
    tags: z.record(z.string(), z.unknown()).optional(),
    timestamp: z.union([z.string(), z.number()]).optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  }),
);

/**
 * Schema for issue objects that can appear in trace responses.
 *
 * When Sentry's trace API returns standalone errors, they are returned as
 * SerializedIssue objects that lack the span-specific fields.
 */
export const TraceIssueSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    issue_id: z.union([z.string(), z.number()]).optional(),
    project_id: z.union([z.string(), z.number()]).optional(),
    project_slug: z.string().optional(),
    title: z.string().optional(),
    culprit: z.string().optional(),
    type: z.string().optional(),
    timestamp: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

/**
 * Schema for Sentry trace response.
 *
 * Contains the complete trace tree starting from root spans.
 * The response is an array that can contain both root-level spans
 * and standalone issue objects. The Sentry API's query_trace_data
 * function returns a mixed list of SerializedSpan and SerializedIssue
 * objects when there are errors not directly associated with spans.
 *
 * Upstream source of truth in getsentry/sentry:
 * - `src/sentry/api/endpoints/organization_trace.py`
 * - `src/sentry/snuba/trace.py` (`SerializedSpan`, `SerializedIssue`)
 */
export const TraceSchema = z.array(
  z.union([TraceSpanSchema, TraceIssueSchema]),
);

const NullableStringOrNumberSchema = z
  .union([z.string(), z.number()])
  .nullable()
  .optional();
const NullableOptionalStringSchema = z
  .string()
  .nullable()
  .optional()
  .transform((value) => value ?? undefined);

export const AIConversationSpanSchema = z
  .object({
    "gen_ai.conversation.id": z.string(),
    span_id: z.string(),
    trace: z.string(),
    parent_span: z.string().nullable().optional(),
    "precise.start_ts": z.number(),
    "precise.finish_ts": z.number(),
    project: z.string(),
    "project.id": z.union([z.string(), z.number()]),
    "span.name": NullableOptionalStringSchema,
    "span.status": NullableOptionalStringSchema,
    "span.op": NullableOptionalStringSchema,
    "span.description": NullableOptionalStringSchema,
    "span.duration": z.number().optional(),
    transaction: NullableOptionalStringSchema,
    is_transaction: z.boolean().optional(),
    "gen_ai.cost.total_tokens": NullableStringOrNumberSchema,
    "gen_ai.operation.type": NullableOptionalStringSchema,
    "gen_ai.input.messages": NullableOptionalStringSchema,
    "gen_ai.output.messages": NullableOptionalStringSchema,
    "gen_ai.system_instructions": NullableOptionalStringSchema,
    "gen_ai.tool.definitions": NullableOptionalStringSchema,
    "gen_ai.request.messages": NullableOptionalStringSchema,
    "gen_ai.response.object": NullableOptionalStringSchema,
    "gen_ai.response.text": NullableOptionalStringSchema,
    "gen_ai.tool.name": NullableOptionalStringSchema,
    "gen_ai.tool.call.arguments": NullableOptionalStringSchema,
    "gen_ai.tool.input": NullableOptionalStringSchema,
    "gen_ai.usage.total_tokens": NullableStringOrNumberSchema,
    "gen_ai.request.model": NullableOptionalStringSchema,
    "gen_ai.response.model": NullableOptionalStringSchema,
    "gen_ai.agent.name": NullableOptionalStringSchema,
    "user.id": NullableOptionalStringSchema,
    "user.email": NullableOptionalStringSchema,
    "user.username": NullableOptionalStringSchema,
    "user.ip": NullableOptionalStringSchema,
  })
  .passthrough();

export const AIConversationSpanListSchema = z.array(AIConversationSpanSchema);

/** Conversation details response envelope (`conversationId`, `title`, `spans`). */
export const AIConversationDetailsResponseSchema = z
  .object({
    conversationId: z.string(),
    title: z.string().nullable(),
    spans: AIConversationSpanListSchema,
  })
  .passthrough();

/**
 * Schemas validated against getsentry/sentry:
 * - `src/sentry/api/endpoints/organization_ai_conversations.py`
 * - `src/sentry/api/serializers/rest_framework/ai_conversations.py`
 * - `tests/sentry/api/endpoints/test_organization_ai_conversations.py`
 */
export const AIConversationUserSchema = z
  .object({
    id: z.string().nullable(),
    email: z.string().nullable(),
    username: z.string().nullable(),
    ip_address: z.string().nullable(),
  })
  .passthrough();

export const AIConversationSummarySchema = z
  .object({
    conversationId: z.string(),
    // AI-generated title from conversation metadata when available.
    title: z.string().nullable(),
    flow: z.array(z.string()),
    errors: z.number(),
    llmCalls: z.number(),
    toolCalls: z.number(),
    totalTokens: z.number(),
    totalCost: z.number(),
    startTimestamp: z.number(),
    endTimestamp: z.number(),
    traceCount: z.number(),
    traceIds: z.array(z.string()),
    firstInput: z.string().nullable(),
    lastOutput: z.string().nullable(),
    user: AIConversationUserSchema.nullable(),
    toolNames: z.array(z.string()),
    toolErrors: z.number(),
  })
  .passthrough();

export const AIConversationSummaryListSchema = z.array(
  AIConversationSummarySchema,
);

/**
 * Schema for individual frames in a flamegraph.
 *
 * Represents a single stack frame with file/function information and
 * whether it's application code or library code.
 */
export const FlamegraphFrameSchema = z
  .object({
    file: z.preprocess((value) => value ?? "", z.string()),
    image: z.string().optional(),
    is_application: z.preprocess((value) => value ?? false, z.boolean()),
    line: z.preprocess((value) => value ?? 0, z.number()),
    name: z.preprocess((value) => value ?? "(unknown)", z.string()),
    path: z.string().optional(),
    fingerprint: z.preprocess((value) => value ?? 0, z.number()),
  })
  .passthrough();

/**
 * Schema for aggregated performance statistics for a single frame.
 *
 * Contains sample counts, total weight/duration, and performance percentiles
 * (p75, p95, p99) for the frame across all samples.
 */
export const FlamegraphFrameInfoSchema = z
  .object({
    count: z.number(),
    weight: z.number().optional(),
    sumDuration: z.number(),
    sumSelfTime: z.number(),
    p75Duration: z.number(),
    p95Duration: z.number(),
    p99Duration: z.number(),
  })
  .passthrough()
  .transform((frameInfo) => ({
    ...frameInfo,
    weight: frameInfo.weight ?? frameInfo.sumDuration,
  }));

/**
 * Schema for profile metadata within a flamegraph response.
 *
 * Links flamegraph samples back to transaction profile IDs or continuous
 * profile chunks. References can also be raw profile ID strings in older
 * speedscope-compatible payloads. Timing fields are optional because Sentry's
 * continuous candidate sources do not all populate the same reference metadata.
 */
export const FlamegraphProfileMetadataSchema = z.union([
  z.string(),
  z
    .object({
      project_id: z.number(),
      profile_id: z.string(),
      start: z.union([z.number(), z.string()]).optional(),
      end: z.union([z.number(), z.string()]).optional(),
    })
    .passthrough(),
  // Compatibility with getsentry/sentry `ContinuousProfileCandidate`:
  // continuous flamegraph refs may come from transaction/spans/functions paths,
  // so only project_id/profiler_id/chunk_id are always present.
  z
    .object({
      project_id: z.number(),
      profiler_id: z.string(),
      chunk_id: z.string(),
      thread_id: z.string().optional(),
      start: z.union([z.number(), z.string()]).optional(),
      end: z.union([z.number(), z.string()]).optional(),
      transaction_id: z.string().nullable().optional(),
    })
    .passthrough(),
]);

/**
 * Schema for a single profile within a flamegraph (typically one per thread).
 *
 * Contains arrays of samples (call stack patterns), their occurrence counts,
 * durations, and relative weights.
 */
export const FlamegraphProfileSchema = z
  .object({
    endValue: z.number(),
    isMainThread: z.boolean(),
    name: z.string(),
    samples: z.array(z.array(z.number())), // Arrays of frame indices
    startValue: z.number(),
    threadID: z.number(),
    type: z.string(),
    unit: z.string(),
    weights: z.array(z.number()),
    sample_durations_ns: z.preprocess(
      (value) => value ?? [],
      z.array(z.number()),
    ),
    sample_counts: z.preprocess((value) => value ?? [], z.array(z.number())),
  })
  .passthrough();

/**
 * Schema for flamegraph API response.
 *
 * Flamegraphs provide pre-aggregated CPU profiling data with:
 * - Unique call stack patterns (samples)
 * - Performance statistics (counts, durations, percentiles)
 * - Frame metadata (file, function, is_application)
 *
 * This is the primary data source for profile analysis as it's
 * already aggregated and includes percentile calculations.
 */
export const FlamegraphSchema = z.preprocess(
  (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return value;
    }

    // Sparse no-data flamegraph responses can carry only `metadata`; keep them
    // parseable so tools can render the explicit no-profile-data result.
    const body = value as Record<string, unknown>;
    const metadata =
      body.metadata && typeof body.metadata === "object"
        ? (body.metadata as Record<string, unknown>)
        : {};

    return {
      ...body,
      platform: body.platform ?? metadata.platform,
      projectID: body.projectID ?? metadata.projectID,
      transactionName: body.transactionName ?? metadata.transactionName,
    };
  },
  z
    .object({
      activeProfileIndex: z.preprocess((value) => value ?? 0, z.number()),
      metadata: z.record(z.string(), z.unknown()).optional(),
      platform: z.string(),
      profiles: z.preprocess(
        (value) => value ?? [],
        z.array(FlamegraphProfileSchema),
      ),
      projectID: z.number(),
      shared: z.preprocess(
        (value) => value ?? {},
        z
          .object({
            frames: z.preprocess(
              (value) => value ?? [],
              z.array(FlamegraphFrameSchema),
            ),
            frame_infos: z.preprocess(
              (value) => value ?? [],
              z.array(FlamegraphFrameInfoSchema),
            ),
            profiles: z.preprocess(
              (value) => value ?? [],
              z.array(FlamegraphProfileMetadataSchema),
            ),
          })
          .passthrough(),
      ),
      transactionName: z.string().optional(),
      metrics: z.unknown().optional(),
    })
    .passthrough(),
);

/**
 * Schema for individual frames in raw profile chunk data.
 *
 * Similar to FlamegraphFrameSchema but uses different field names
 * (function instead of name, in_app instead of is_application).
 * Many fields are optional as the API may not include them for all frames.
 *
 * Upstream source of truth in getsentry/sentry:
 * - `static/app/types/profiling.d.ts` (`SentrySampledProfileFrame`)
 * - `static/app/utils/profiling/profile/utils.tsx`
 * - `src/sentry/profiles/task.py`
 *
 * In particular, `function` must remain optional here. Sentry's frontend
 * import path already falls back with `frame.function ?? "unknown"`, and the
 * profile processing pipeline uses `frame.get("function", "")`.
 */
export const ProfileFrameSchema = z
  .object({
    filename: z.string().nullable().optional(),
    function: z.string().nullable().optional(),
    in_app: z.boolean(),
    lineno: z.number().nullable().optional(),
    colno: z.number().nullable().optional(),
    module: z.string().nullable().optional(),
    abs_path: z.string().nullable().optional(),
    platform: z.string().nullable().optional(),
    instruction_addr: z.string().nullable().optional(),
    class_name: z.string().nullable().optional(),
    raw_function: z.string().nullable().optional(),
    symbol: z.string().nullable().optional(),
    lang: z.string().nullable().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const ProfileThreadMetadataSchema = z.record(
  z.string(),
  z
    .object({
      // Matches Sentry's `Profiling.ContinuousProfile.thread_metadata` type,
      // where metadata entries may include only priority.
      name: z.string().nullable().optional(),
      priority: z.number().nullable().optional(),
    })
    .passthrough(),
);

/**
 * Schema for a single V2 continuous profile chunk sample.
 *
 * V2 chunks are produced by the continuous profiler and span multiple
 * transactions. Each sample carries an absolute (or relative-to-chunk) wall
 * clock `timestamp` in seconds and a string `thread_id` matching
 * `thread_metadata` keys.
 *
 * Upstream type reference in getsentry/sentry:
 * - `static/app/types/profiling.d.ts` (`SentrySampledProfileChunkSample`)
 */
export const ProfileChunkSampleSchema = z
  .object({
    stack_id: z.number(),
    thread_id: z.string(),
    timestamp: z.number(),
    queue_address: z.string().optional(),
  })
  .passthrough();

/**
 * Schema for a single V1 transaction profile sample.
 *
 * V1 samples are produced per-transaction by Sentry's profiling service
 * (vroom). They differ from V2 chunk samples in two important ways:
 * - `thread_id` is serialized as a Go `uint64` (a number on the wire). It is
 *   normalized to a string here so downstream code can compare against the
 *   string keys in `thread_metadata`.
 * - Time is carried as `elapsed_since_start_ns` (uint64 nanoseconds since the
 *   start of the profile). V1 samples never carry an absolute `timestamp`.
 *
 * Upstream references in getsentry/sentry:
 * - `static/app/types/profiling.d.ts` (`SentrySampledProfileSample`)
 * - `src/sentry/api/endpoints/project_profiling_profile.py`
 */
export const TransactionProfileSampleSchema = z
  .object({
    stack_id: z.number(),
    thread_id: z.union([z.string(), z.number()]).transform(String),
    elapsed_since_start_ns: z.number(),
    queue_address: z.string().optional(),
  })
  .passthrough();

/**
 * Schema for raw V2 continuous-profile chunk data.
 *
 * Contains the raw sampling data including:
 * - frames: All unique stack frames
 * - samples: Individual sample points with timestamps
 * - stacks: Arrays of frame indices forming call stacks
 * - thread_metadata: Information about profiled threads
 *
 * This is used for deep-dive analysis when flamegraph data isn't sufficient.
 */
export const ProfileChunkSchema = z
  .object({
    chunk_id: z.string(),
    profiler_id: z.string().optional(),
    event_id: z.string().optional(),
    environment: z.preprocess((value) => value ?? null, z.string().nullable()),
    platform: z.preprocess((value) => value ?? "unknown", z.string()),
    release: z.preprocess((value) => value ?? "unknown", z.string()),
    version: z.preprocess((value) => value ?? "2", z.string()),
    profile: z.object({
      frames: z.array(ProfileFrameSchema),
      samples: z.array(ProfileChunkSampleSchema),
      stacks: z.array(z.array(z.number())),
      thread_metadata: z.preprocess(
        (value) => value ?? {},
        ProfileThreadMetadataSchema,
      ),
    }),
  })
  .passthrough();

/**
 * Schema for profile chunks API response wrapper.
 *
 * Sentry returns a singular `chunk` wrapper for single chunk requests. The
 * frontend also backfills profiler_id from the query because profiling-service
 * chunks may omit it. The legacy plural `chunks` wrapper remains accepted for
 * older fixtures and mocks.
 */
export const ProfileChunkResponseSchema = z.union([
  z
    .object({
      chunk: ProfileChunkSchema.nullable(),
    })
    .passthrough()
    .transform((response) => ({
      chunks: response.chunk ? [response.chunk] : [],
    })),
  z
    .object({
      chunks: z.array(ProfileChunkSchema),
    })
    .passthrough()
    .transform((response) => ({
      chunks: response.chunks,
    })),
]);

const ProfileReleaseSchema = z
  .union([
    z.string(),
    z
      .object({
        version: z.string(),
      })
      .passthrough(),
    z.null(),
  ])
  .optional();

/**
 * Schema for a V1 transaction profile response.
 *
 * Unlike V2 continuous profile chunks, transaction profiles are scoped to a
 * single transaction and always include a `transaction` object. vroom emits
 * both `Sample.thread_id` and `Transaction.active_thread_id` as `uint64`, so
 * both are accepted as number or string here and normalized to strings.
 *
 * Upstream source of truth in getsentry/sentry:
 * - `src/sentry/api/endpoints/project_profiling_profile.py`
 * - `static/app/types/profiling.d.ts` (`SentrySampledProfile`)
 *
 * The project profiling endpoint largely proxies the profiling-service payload
 * and only normalizes release metadata, so this schema should track the wire
 * payload Sentry consumes rather than introducing stricter local requirements.
 */
export const TransactionProfileSchema = z
  .object({
    event_id: z.string().optional(),
    profile_id: z.string().optional(),
    profiler_id: z.string().optional(),
    environment: z.string().nullable().optional(),
    platform: z.string(),
    release: ProfileReleaseSchema,
    version: z.union([z.string(), z.number()]).transform(String).optional(),
    profile: z.object({
      frames: z.array(ProfileFrameSchema),
      samples: z.array(TransactionProfileSampleSchema),
      stacks: z.array(z.array(z.number())),
      thread_metadata: z.preprocess(
        (value) => value ?? {},
        ProfileThreadMetadataSchema,
      ),
    }),
    transaction: z
      .object({
        name: z.string().optional(),
        trace_id: z.string().optional(),
        id: z.string().optional(),
        active_thread_id: z
          .union([z.string(), z.number()])
          .transform(String)
          .optional(),
        relative_start_ns: z
          .union([z.string(), z.number()])
          .transform((value) => Number(value))
          .optional(),
        relative_end_ns: z
          .union([z.string(), z.number()])
          .transform((value) => Number(value))
          .optional(),
      })
      .passthrough()
      .optional(),
    device: z
      .object({
        classification: z.string().nullable().optional(),
        manufacturer: z.string().nullable().optional(),
        locale: z.string().nullable().optional(),
        model: z.string().nullable().optional(),
        arch: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    os: z
      .object({
        name: z.string().nullable().optional(),
        version: z.string().nullable().optional(),
        build_number: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    client_sdk: z
      .object({
        name: z.string().nullable().optional(),
        version: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export const AgenticOnboardingStageSchema = z.enum([
  "connect_mcp",
  "analyze_project",
  "create_project",
  "instrument_app",
  "plan_test_error",
  "send_verification_error",
  "receive_verification_error",
  "prepare_production",
  "check_stack_trace_quality",
]);

export const AgenticOnboardingStageStatusSchema = z.enum([
  "active",
  "waiting",
  "completed",
  "skipped",
  "failed",
  "bypassed",
]);

export const AgenticOnboardingStageStatusUpdateSchema = z.enum([
  "active",
  "waiting",
  "completed",
  "skipped",
  "failed",
]);

const AgenticOnboardingCreateProjectExtraSchema = z
  .object({
    projectSlugs: z.array(z.string().trim().min(1)),
  })
  .strict();

const AgenticOnboardingVerificationErrorExtraSchema = z
  .object({
    issueIds: z.array(z.string().trim().min(1)),
  })
  .strict();

const AgenticOnboardingStageWithoutExtraSchema =
  AgenticOnboardingStageSchema.exclude([
    "create_project",
    "receive_verification_error",
  ]);

const AgenticOnboardingStageStateBaseSchema = z.object({
  status: AgenticOnboardingStageStatusSchema.nullable(),
  eventNote: z.string().nullable(),
});

export const AgenticOnboardingStageStateSchema = z.discriminatedUnion("stage", [
  AgenticOnboardingStageStateBaseSchema.extend({
    stage: z.literal("create_project"),
    extra: AgenticOnboardingCreateProjectExtraSchema.nullable(),
  }),
  AgenticOnboardingStageStateBaseSchema.extend({
    stage: z.literal("receive_verification_error"),
    extra: AgenticOnboardingVerificationErrorExtraSchema.nullable(),
  }),
  AgenticOnboardingStageStateBaseSchema.extend({
    stage: AgenticOnboardingStageWithoutExtraSchema,
    extra: z.null(),
  }),
]);

export const AgenticOnboardingRunStatusSchema = z.enum([
  "active",
  "completed",
  "failed",
  "cancelled",
]);

export const AgenticOnboardingRunStatusUpdateSchema = z.enum([
  "completed",
  "failed",
]);

export const AgenticOnboardingRunTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9]{10}$/);

const AgenticOnboardingStatusUpdateBaseSchema = z.object({
  schemaVersion: z.literal(1),
  runToken: AgenticOnboardingRunTokenSchema,
  status: AgenticOnboardingStageStatusUpdateSchema,
  runStatus: AgenticOnboardingRunStatusUpdateSchema.optional(),
  eventNote: z.string().trim().min(1).max(256).optional(),
});

export const AgenticOnboardingStatusUpdateSchema = z.discriminatedUnion(
  "stage",
  [
    AgenticOnboardingStatusUpdateBaseSchema.extend({
      stage: z.literal("create_project"),
      extra: AgenticOnboardingCreateProjectExtraSchema.optional(),
    }),
    AgenticOnboardingStatusUpdateBaseSchema.extend({
      stage: z.literal("receive_verification_error"),
      extra: AgenticOnboardingVerificationErrorExtraSchema.optional(),
    }),
    AgenticOnboardingStatusUpdateBaseSchema.extend({
      stage: AgenticOnboardingStageWithoutExtraSchema,
      extra: z.never().optional(),
    }),
  ],
);

export const AgenticOnboardingRunSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  channelId: z.string(),
  clientRunId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  sequence: z.number().int().nonnegative(),
  expiresAt: z.string(),
  continueUpdates: z.boolean(),
  runStatus: AgenticOnboardingRunStatusSchema,
  stages: z.array(AgenticOnboardingStageStateSchema),
});

/**
 * One bucket of an events-timeseries series. `timestamp` is in milliseconds.
 * `incomplete` marks buckets that may still receive data.
 */
export const EventsTimeSeriesValueSchema = z
  .object({
    timestamp: z.number(),
    value: z.number().nullish(),
    incomplete: z.boolean(),
  })
  .passthrough();

/**
 * Response from the events-timeseries endpoint. The MCP always requests a
 * single yAxis without topEvents, so `timeSeries` holds exactly one series.
 */
export const EventsTimeSeriesResponseSchema = z
  .object({
    timeSeries: z.array(
      z
        .object({
          yAxis: z.string(),
          values: z.array(EventsTimeSeriesValueSchema),
          meta: z
            .object({
              // Bucket width in milliseconds
              interval: z.number(),
            })
            .passthrough(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type EventsTimeSeriesResponse = z.infer<
  typeof EventsTimeSeriesResponseSchema
>;

export const DroppedEventsBucketSchema = z
  .object({
    type: z.string(),
    category: z.string(),
    outcome: z.string(),
    reason: z.string(),
    start: z.number(),
    end: z.number(),
    count: z.number(),
  })
  .passthrough();

export const DroppedEventsResponseSchema = z
  .object({
    meta: z
      .object({
        dataset: z.string(),
        start: z.number(),
        end: z.number(),
        interval: z.number(),
      })
      .passthrough(),
    droppedEvents: z.array(DroppedEventsBucketSchema),
    acceptedEvents: z.array(DroppedEventsBucketSchema),
  })
  .passthrough();
