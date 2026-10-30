import { z } from "zod";
import type { SentryApiService } from "../../../api-client";
import { agentTool } from "./utils";

export type DatasetType = "events" | "errors" | "replays" | "search_issues";
type DatasetTag = Awaited<ReturnType<SentryApiService["listTags"]>>[number];

export interface DatasetField {
  key: string;
  name: string;
  totalValues: number;
  examples?: string[];
}

export interface DatasetFieldsResult {
  dataset: string;
  fields: DatasetField[];
  commonPatterns: Array<{ pattern: string; description: string }>;
}

interface CommonPattern {
  pattern: string;
  description: string;
  requiredFields?: string[];
}

const REPLAY_EXCLUDED_TAGS = new Set(["browser", "device", "os", "user"]);

const REPLAY_FIELDS = [
  "activity",
  "browser.name",
  "browser.version",
  "count_dead_clicks",
  "count_errors",
  "count_infos",
  "count_rage_clicks",
  "count_screens",
  "count_segments",
  "count_traces",
  "count_urls",
  "count_warnings",
  "device.brand",
  "device.family",
  "device.model_id",
  "device.name",
  "dist",
  "duration",
  "error_ids",
  "id",
  "is_archived",
  "os.name",
  "os.version",
  "platform",
  "release",
  "replay_type",
  "screen",
  "screens",
  "sdk.name",
  "sdk.version",
  "seen_by_me",
  "trace",
  "url",
  "urls",
  "user.email",
  "user.id",
  "user.ip",
  "user.username",
  "user.geo.city",
  "user.geo.country_code",
  "user.geo.region",
  "user.geo.subdivision",
  "viewed_by_me",
  "ota_updates.channel",
  "ota_updates.runtime_version",
  "ota_updates.update_id",
] as const;

const REPLAY_CLICK_FIELDS = [
  "click.alt",
  "click.class",
  "click.id",
  "click.label",
  "click.role",
  "click.selector",
  "dead.selector",
  "rage.selector",
  "click.tag",
  "click.textContent",
  "click.title",
  "click.testid",
  "click.component_name",
] as const;

const REPLAY_TAP_FIELDS = [
  "tap.message",
  "tap.view_id",
  "tap.view_class",
] as const;

const REPLAY_BUILT_IN_FIELDS = [
  ...REPLAY_FIELDS,
  ...REPLAY_CLICK_FIELDS,
  ...REPLAY_TAP_FIELDS,
] as const;

/**
 * Discover available fields for a dataset by querying Sentry's tags API.
 * Replay search mirrors Sentry's UI by merging built-in replay fields, click/tap fields, and custom tags.
 */
export async function discoverDatasetFields(
  apiService: SentryApiService,
  organizationSlug: string,
  dataset: DatasetType,
  options: {
    projectId?: string;
  } = {},
): Promise<DatasetFieldsResult> {
  const { projectId } = options;

  // Get available tags for the dataset
  const tags = await apiService.listTags({
    organizationSlug,
    dataset,
    project: projectId,
    statsPeriod: "14d",
  });

  if (dataset === "replays") {
    const fields = buildReplayFields(tags);

    return {
      dataset,
      fields,
      commonPatterns: getReplayCommonPatterns(
        new Set(fields.map((field) => field.key)),
      ),
    };
  }

  // Filter out internal Sentry tags and format
  const fields = tags
    .filter((tag) => !tag.key.startsWith("sentry:"))
    .map((tag) => ({
      key: tag.key,
      name: tag.name,
      totalValues: tag.totalValues,
      examples: getFieldExamples(tag.key, dataset),
    }));

  return {
    dataset,
    fields,
    commonPatterns: getCommonPatterns(dataset),
  };
}

/**
 * Create a tool for discovering available fields in a dataset
 * The tool is pre-bound with the API service and organization configured for the appropriate region
 */
export function createDatasetFieldsTool(options: {
  apiService: SentryApiService;
  organizationSlug: string;
  dataset: DatasetType;
  projectId?: string;
}) {
  const { apiService, organizationSlug, dataset, projectId } = options;
  return agentTool({
    description: `Discover available fields for ${dataset} searches in Sentry (includes example values)`,
    parameters: z.object({}),
    execute: async () => {
      return await discoverDatasetFields(
        apiService,
        organizationSlug,
        dataset,
        {
          projectId,
        },
      );
    },
    getResultCount: (result) => result.fields.length,
  });
}

/**
 * Get example values for common fields
 */
export function getFieldExamples(
  key: string,
  dataset: string,
): string[] | undefined {
  const commonExamples: Record<string, string[]> = {
    level: ["error", "warning", "info", "debug", "fatal"],
    environment: ["production", "staging", "development"],
    release: ["v1.0.0", "latest", "backend@1.2.3"],
    user: ["user123", "email@example.com"],
  };

  const issueExamples: Record<string, string[]> = {
    ...commonExamples,
    assigned_or_suggested: ["email@example.com", "team-slug", "me"],
    is: [
      "unresolved",
      "resolved",
      "ignored",
      "for_review",
      "new",
      "regressed",
      "escalating",
    ],
    "issue.category": ["error", "feedback", "outage"],
    "issue.priority": ["high", "medium", "low"],
  };

  const eventExamples: Record<string, string[]> = {
    ...commonExamples,
    "http.method": ["GET", "POST", "PUT", "DELETE"],
    "http.status_code": ["200", "404", "500"],
    "db.system": ["postgresql", "mysql", "redis"],
  };

  const replayExamples: Record<string, string[]> = {
    ...commonExamples,
    activity: ["1", "5", "10"],
    "browser.name": ["Chrome", "Safari", "Mobile Safari"],
    "browser.version": ["131.0.0", "18.3", "136.0.7103.93"],
    duration: ["30s", "2m", "10m"],
    count_errors: ["0", "1", "5"],
    count_infos: ["0", "2", "8"],
    count_dead_clicks: ["0", "1", "3"],
    count_rage_clicks: ["0", "1", "3"],
    count_screens: ["1", "3", "8"],
    count_segments: ["1", "2", "4"],
    count_traces: ["0", "1", "2"],
    count_urls: ["1", "3", "6"],
    count_warnings: ["0", "1", "4"],
    "device.brand": ["Apple", "Google", "Samsung"],
    "device.family": ["iPhone", "Pixel", "Desktop"],
    "device.model_id": ["iPhone16,2", "Pixel 8"],
    "device.name": ["MacBook Pro", "iPhone", "Pixel 8"],
    dist: ["42", "frontend-2025.01.15"],
    error_ids: ["0194c40cc83f4bc2b73f8dd72fbd3a8e"],
    id: ["7e07485f-12f9-416b-8b14-26260799b51f"],
    is_archived: ["true", "false"],
    "os.name": ["macOS", "iOS", "Android", "Windows"],
    "os.version": ["14.4", "18.3", "15"],
    platform: ["javascript", "cocoa", "android"],
    replay_type: ["session", "buffer"],
    viewed_by_me: ["true", "false"],
    seen_by_me: ["true", "false"],
    url: ["/checkout", "/settings", "/billing"],
    urls: ["/checkout", "/checkout/payment", "/settings/profile"],
    screen: ["Checkout", "Billing", "Settings"],
    screens: ["Checkout", "Billing", "Settings"],
    "sdk.name": [
      "sentry.javascript.react",
      "sentry.javascript.nextjs",
      "sentry.cocoa",
    ],
    "sdk.version": ["8.40.0", "8.43.0", "8.20.1"],
    trace: ["a4d1aae7216b47ff8117cf4e09ce9d0a"],
    "user.email": ["user@example.com", "alice@example.com"],
    "user.id": ["user-123", "42"],
    "user.ip": ["203.0.113.42", "198.51.100.7"],
    "user.username": ["alice", "checkout-user"],
    "user.geo.city": ["San Francisco", "Toronto"],
    "user.geo.country_code": ["US", "CA"],
    "user.geo.region": ["California", "Ontario"],
    "user.geo.subdivision": ["US-CA", "CA-ON"],
    "ota_updates.channel": ["production", "preview"],
    "ota_updates.runtime_version": ["1.0.0", "1.1.0"],
    "ota_updates.update_id": [
      "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      "12f9d5bf-4545-4d4a-aeca-878d3a841f1a",
    ],
    "click.alt": ["Checkout", "Save settings"],
    "click.class": ["btn-primary", "nav-link"],
    "click.id": ["checkout-submit", "save-settings"],
    "click.label": ["Save", "Continue"],
    "click.role": ["button", "link"],
    "click.selector": ['button[data-test-id="save"]', "#checkout-submit"],
    "dead.selector": ["button.disabled", ".pricing-card"],
    "rage.selector": ["button.checkout", ".menu-item"],
    "click.tag": ["button", "a"],
    "click.textContent": ["Save", "Complete Purchase"],
    "click.title": ["Save changes", "Go to billing"],
    "click.testid": ["save-button", "checkout-submit"],
    "click.component_name": ["CheckoutButton", "NavItem"],
    "tap.message": ["CheckoutScreen", "CartScreen"],
    "tap.view_id": ["checkout-root", "cart-root"],
    "tap.view_class": ["CheckoutViewController", "CartActivity"],
  };

  if (dataset === "search_issues") {
    return issueExamples[key];
  }
  if (dataset === "replays") {
    return replayExamples[key];
  }
  if (dataset === "events" || dataset === "errors") {
    return eventExamples[key];
  }

  return commonExamples[key];
}

/**
 * Get common search patterns for a dataset
 */
export function getCommonPatterns(dataset: string) {
  if (dataset === "search_issues") {
    return [
      { pattern: "is:unresolved", description: "Open issues" },
      { pattern: "is:resolved", description: "Closed issues" },
      { pattern: "is:for_review", description: "Issues in the review queue" },
      { pattern: "level:error", description: "Error level issues" },
      {
        pattern: "assigned_or_suggested:me",
        description: "Issues assigned or suggested to the current user",
      },
      {
        pattern: "issue.category:feedback",
        description: "User feedback issues",
      },
      {
        pattern: "firstSeen:-24h",
        description: "New issues from last 24 hours",
      },
      {
        pattern: "userCount:>100",
        description: "Affecting more than 100 users",
      },
    ];
  }
  if (dataset === "events" || dataset === "errors") {
    return [
      { pattern: "level:error", description: "Error events" },
      { pattern: "environment:production", description: "Production events" },
      { pattern: "timestamp:-1h", description: "Events from last hour" },
      { pattern: "has:http.method", description: "HTTP requests" },
      { pattern: "has:db.statement", description: "Database queries" },
    ];
  }
  if (dataset === "replays") {
    return REPLAY_COMMON_PATTERNS.map(({ pattern, description }) => ({
      pattern,
      description,
    }));
  }

  return [];
}

function buildReplayFields(tags: DatasetTag[]): DatasetField[] {
  const tagMap = new Map(
    tags
      .filter(
        (tag) =>
          !tag.key.startsWith("sentry:") && !REPLAY_EXCLUDED_TAGS.has(tag.key),
      )
      .map((tag) => [tag.key, tag]),
  );

  const builtInKeys = new Set<string>(REPLAY_BUILT_IN_FIELDS);
  const builtInFields = REPLAY_BUILT_IN_FIELDS.filter((key) =>
    tagMap.has(key),
  ).map((key) => createDatasetField(key, "replays", tagMap.get(key)));

  const customTagFields = [...tagMap.values()]
    .filter((tag) => !builtInKeys.has(tag.key))
    .sort((left, right) => {
      if (right.totalValues !== left.totalValues) {
        return right.totalValues - left.totalValues;
      }
      return left.key.localeCompare(right.key);
    })
    .map((tag) => createDatasetField(tag.key, "replays", tag));

  return [...builtInFields, ...customTagFields];
}

function createDatasetField(
  key: string,
  dataset: DatasetType,
  tag?: DatasetTag,
): DatasetField {
  return {
    key,
    name: tag?.name ?? humanizeFieldName(key),
    totalValues: tag?.totalValues ?? 0,
    examples: getFieldExamples(key, dataset),
  };
}

function humanizeFieldName(key: string): string {
  return key
    .replaceAll(".", " ")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

const REPLAY_COMMON_PATTERNS: CommonPattern[] = [
  {
    pattern: "count_errors:>0",
    description: "Replays with associated errors",
    requiredFields: ["count_errors"],
  },
  {
    pattern: "count_rage_clicks:>0",
    description: "Replays with rage clicks",
    requiredFields: ["count_rage_clicks"],
  },
  {
    pattern: "count_dead_clicks:>0",
    description: "Replays with dead clicks",
    requiredFields: ["count_dead_clicks"],
  },
  {
    pattern: "url:*checkout*",
    description: "Replays that visited a checkout page",
    requiredFields: ["url"],
  },
  {
    pattern: 'click.textContent:"Save"',
    description: "Replays where a Save button was clicked",
    requiredFields: ["click.textContent"],
  },
  {
    pattern: "tap.message:*Checkout*",
    description: "Mobile replay screens related to checkout",
    requiredFields: ["tap.message"],
  },
  {
    pattern: "viewed_by_me:true",
    description: "Replays you have already viewed",
    requiredFields: ["viewed_by_me"],
  },
];

function getReplayCommonPatterns(
  availableFields: Set<string>,
): Array<{ pattern: string; description: string }> {
  return REPLAY_COMMON_PATTERNS.filter(
    (pattern) =>
      !pattern.requiredFields ||
      pattern.requiredFields.every((field) => availableFields.has(field)),
  ).map(({ pattern, description }) => ({
    pattern,
    description,
  }));
}
