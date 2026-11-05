import {
  array,
  boolean,
  description,
  fallback,
  type GenericSchema,
  type InferOutput,
  looseObject,
  nullable,
  nullish,
  number,
  object,
  optional,
  pipe,
  record,
  string,
  union,
  unknown,
} from "valibot";
import type {
  ReplayActivityEventSchema,
  ReplayRelatedIssueSchema,
  ReplayRelatedTraceSchema,
} from "../output-schemas/replay.js";

export type ReplayTags = Record<string, string[]>;

/**
 * User geo metadata attached to a replay.
 */
export const ReplayGeoSchema = pipe(
  looseObject({
    city: nullish(string()),
    country_code: nullish(string()),
    region: nullish(string()),
    subdivision: nullish(string()),
  }),
  description("User geo metadata"),
);

/**
 * User metadata attached to a replay.
 */
export const ReplayUserSchema = pipe(
  looseObject({
    id: nullish(string()),
    username: nullish(string()),
    email: nullish(string()),
    ip: nullish(string()),
    display_name: nullish(string()),
    geo: nullish(ReplayGeoSchema),
  }),
  description("User metadata"),
);

/**
 * Browser metadata attached to a replay.
 */
export const ReplayBrowserSchema = pipe(
  looseObject({
    name: nullish(string()),
    version: nullish(string()),
  }),
  description("Browser metadata"),
);

/**
 * Operating system metadata attached to a replay.
 */
export const ReplayOsSchema = pipe(
  looseObject({
    name: nullish(string()),
    version: nullish(string()),
  }),
  description("Operating system metadata"),
);

/**
 * SDK metadata attached to a replay.
 */
export const ReplaySdkSchema = pipe(
  looseObject({
    name: nullish(string()),
    version: nullish(string()),
  }),
  description("SDK metadata"),
);

/**
 * Device metadata attached to a replay.
 */
export const ReplayDeviceSchema = pipe(
  looseObject({
    brand: nullish(string()),
    family: nullish(string()),
    model: nullish(string()),
    model_id: nullish(string()),
    name: nullish(string()),
  }),
  description("Device metadata"),
);

/**
 * OTA update metadata attached to a replay.
 */
export const ReplayOtaUpdatesSchema = pipe(
  looseObject({
    channel: nullish(string()),
    runtime_version: nullish(string()),
    update_id: nullish(string()),
  }),
  description("OTA update metadata"),
);

/**
 * Replay tags keyed by tag name.
 *
 * Archived replay rows sometimes return an empty array instead of a tag map,
 * so the schema falls back to an empty tag object for those placeholders.
 */
export const ReplayTagsSchema = pipe(
  fallback(record(string(), array(string())), {}),
  description("Replay tags"),
) as GenericSchema<unknown, ReplayTags>;

/**
 * Known root fields that the replay list endpoint accepts in repeated `field=`
 * query params.
 *
 * These are intentionally the root field names expected by the backend
 * validator, not dotted nested field names.
 */
export const REPLAY_LIST_FIELDS = [
  "activity",
  "browser",
  "count_dead_clicks",
  "count_errors",
  "count_infos",
  "count_rage_clicks",
  "count_segments",
  "count_urls",
  "count_warnings",
  "device",
  "dist",
  "duration",
  "environment",
  "error_ids",
  "finished_at",
  "has_viewed",
  "id",
  "info_ids",
  "is_archived",
  "os",
  "platform",
  "project_id",
  "releases",
  "sdk",
  "started_at",
  "tags",
  "trace_ids",
  "urls",
  "user",
  "warning_ids",
] as const;

function replayNullableNumber(descriptionText: string) {
  return pipe(optional(nullable(number())), description(descriptionText));
}

function replayNullableString(descriptionText: string) {
  return pipe(optional(nullable(string())), description(descriptionText));
}

function replayNullableBoolean(descriptionText: string) {
  return pipe(optional(nullable(boolean())), description(descriptionText));
}

function replayNullishObject<T extends GenericSchema>(
  schema: T,
  descriptionText: string,
) {
  return pipe(nullish(schema), description(descriptionText));
}

export function replayStringArray() {
  return array(string());
}

function replayStringArrayWithFallback() {
  return fallback(replayStringArray(), []);
}

export function buildReplayListItemShape<
  TErrorIds extends GenericSchema,
  TInfoIds extends GenericSchema,
  TOtaUpdates extends GenericSchema,
  TProjectId extends GenericSchema,
  TReleases extends GenericSchema,
  TTags extends GenericSchema,
  TTraceIds extends GenericSchema,
  TUrls extends GenericSchema,
  TWarningIds extends GenericSchema,
>(fields: {
  errorIds: TErrorIds;
  infoIds: TInfoIds;
  otaUpdates: TOtaUpdates;
  projectId: TProjectId;
  releases: TReleases;
  tags: TTags;
  traceIds: TTraceIds;
  urls: TUrls;
  warningIds: TWarningIds;
}) {
  return {
    activity: replayNullableNumber("Replay activity score"),
    browser: replayNullishObject(ReplayBrowserSchema, "Browser metadata"),
    count_dead_clicks: replayNullableNumber("Dead click count"),
    count_errors: replayNullableNumber("Associated error count"),
    count_infos: replayNullableNumber("Info event count"),
    count_rage_clicks: replayNullableNumber("Rage click count"),
    count_segments: replayNullableNumber("Recording segment count"),
    count_urls: replayNullableNumber("Visited URL count"),
    count_warnings: replayNullableNumber("Warning event count"),
    device: replayNullishObject(ReplayDeviceSchema, "Device metadata"),
    dist: replayNullableString("Distribution"),
    duration: replayNullableNumber("Replay duration in seconds"),
    environment: replayNullableString("Environment"),
    error_ids: pipe(fields.errorIds, description("Linked error IDs")),
    finished_at: replayNullableString("Replay finish timestamp"),
    has_viewed: replayNullableBoolean(
      "Whether the current user has viewed the replay",
    ),
    id: pipe(string(), description("Replay ID")),
    info_ids: pipe(fields.infoIds, description("Linked info event IDs")),
    is_archived: replayNullableBoolean("Archived flag"),
    os: replayNullishObject(ReplayOsSchema, "Operating system metadata"),
    ota_updates: pipe(fields.otaUpdates, description("OTA update metadata")),
    platform: replayNullableString("Platform"),
    project_id: pipe(fields.projectId, description("Numeric project ID")),
    releases: pipe(fields.releases, description("Associated releases")),
    sdk: replayNullishObject(ReplaySdkSchema, "SDK metadata"),
    started_at: replayNullableString("Replay start timestamp"),
    tags: pipe(fields.tags, description("Replay tags")),
    trace_ids: pipe(fields.traceIds, description("Linked trace IDs")),
    urls: pipe(fields.urls, description("Visited URLs")),
    user: replayNullishObject(ReplayUserSchema, "User metadata"),
    warning_ids: pipe(
      fields.warningIds,
      description("Linked warning event IDs"),
    ),
  };
}

/**
 * A single replay row returned by the organization replay index endpoint.
 *
 * Duration is in seconds, matching the backend replay interchange format.
 */
const ReplayListItemSchemaBase = looseObject(
  buildReplayListItemShape({
    errorIds: replayStringArrayWithFallback(),
    infoIds: replayStringArrayWithFallback(),
    otaUpdates: replayNullishObject(
      ReplayOtaUpdatesSchema,
      "OTA update metadata",
    ),
    projectId: optional(nullable(union([string(), number()]))),
    releases: replayStringArrayWithFallback(),
    tags: ReplayTagsSchema,
    traceIds: replayStringArrayWithFallback(),
    urls: replayStringArrayWithFallback(),
    warningIds: replayStringArrayWithFallback(),
  }),
);
export const ReplayListItemSchema = pipe(
  ReplayListItemSchemaBase,
  description("Replay list row"),
);

/**
 * Click selector summaries attached to replay detail responses.
 */
export const ReplayClickSchema = pipe(
  record(string(), unknown()),
  description("Replay click selector summary"),
);

/**
 * Full replay metadata returned by the replay detail endpoint.
 */
export const ReplayDetailsSchema = pipe(
  looseObject({
    ...ReplayListItemSchemaBase.entries,
    clicks: pipe(
      optional(array(ReplayClickSchema)),
      description("Replay click summaries"),
    ),
    replay_type: pipe(optional(nullable(string())), description("Replay type")),
  }),
  description("Replay details"),
);

/** Envelope returned by the replay index endpoint. */
export const ReplayListResponseSchema = looseObject({
  data: array(ReplayListItemSchema),
});

/** Envelope returned by the replay detail endpoint. */
export const ReplayDetailsResponseSchema = looseObject({
  data: ReplayDetailsSchema,
});

/** Replay IDs keyed by resource identifier (issue ID, trace ID, replay ID). */
export const ReplayIdsByResourceSchema = pipe(
  record(string(), array(string())),
  description("Replay IDs grouped by resource identifier"),
);

export type ReplayGeo = InferOutput<typeof ReplayGeoSchema>;
export type ReplayUser = InferOutput<typeof ReplayUserSchema>;
export type ReplayBrowser = InferOutput<typeof ReplayBrowserSchema>;
export type ReplayOs = InferOutput<typeof ReplayOsSchema>;
export type ReplaySdk = InferOutput<typeof ReplaySdkSchema>;
export type ReplayDevice = InferOutput<typeof ReplayDeviceSchema>;
export type ReplayOtaUpdates = InferOutput<typeof ReplayOtaUpdatesSchema>;
/**
 * `project_id` as the API layer returns it: the replay API sends a number,
 * which `lib/api/replays.ts` normalizes to a string.
 */
export type ReplayStringProjectId = { project_id?: string | null };
export type ReplayListItem = InferOutput<typeof ReplayListItemSchema> &
  ReplayStringProjectId;
export type ReplayDetails = InferOutput<typeof ReplayDetailsSchema> &
  ReplayStringProjectId;
export type ReplayListResponse = InferOutput<typeof ReplayListResponseSchema>;
export type ReplayDetailsResponse = InferOutput<
  typeof ReplayDetailsResponseSchema
>;
export type ReplayIdsByResource = InferOutput<typeof ReplayIdsByResourceSchema>;
export type ReplayActivityEvent = InferOutput<typeof ReplayActivityEventSchema>;
export type ReplayRelatedIssue = InferOutput<typeof ReplayRelatedIssueSchema>;
export type ReplayRelatedTrace = InferOutput<typeof ReplayRelatedTraceSchema>;
