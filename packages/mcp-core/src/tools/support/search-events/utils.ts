import { getActiveSpan } from "@sentry/core";
import { z } from "zod";
import type {
  EventsQueryValidation,
  EventsValidationResult,
  SentryApiService,
  TraceItemAttributeType,
  TraceItemType,
} from "../../../api-client";
import { UserInputError } from "../../../errors";
import {
  agentTool,
  recordAgentToolResultCount,
} from "../../../internal/agents/tools/utils";
import {
  formatUserGeoSummary,
  isPlainObject,
} from "../../../internal/user-formatting";
import {
  type EventsDataset,
  normalizeEventsDataset,
  PUBLIC_EVENTS_DATASETS,
} from "../../../utils/events-datasets";

// Type for flexible event data that can contain any fields
export type FlexibleEventData = Record<string, unknown>;

const DEFAULT_MAX_VALUE_LENGTH = 200;
const DEFAULT_MAX_ARRAY_ITEMS = 20;
const SENTRY_SEARCH_TOKEN_PATTERN =
  /(^|\s)!?([A-Za-z_][A-Za-z0-9_.[\],-]*):(?=\S)(?!\/\/)/g;
const KNOWN_SENTRY_SEARCH_KEYS = new Set([
  "browser",
  "device",
  "duration",
  "environment",
  "error.type",
  "http.status_code",
  "issue",
  "level",
  "message",
  "os",
  "project",
  "release",
  "severity",
  "span.action",
  "span.description",
  "span.module",
  "span.op",
  "span.status",
  "timestamp",
  "trace",
  "transaction",
  "transaction.duration",
  "transaction.op",
  "url",
  "user",
  "user.email",
  "user.id",
  "user.username",
]);

// Helper to safely get a string value from event data
export function getStringValue(
  event: FlexibleEventData,
  key: string,
  defaultValue = "",
): string {
  const value = event[key];
  return typeof value === "string" ? value : defaultValue;
}

// Helper to safely get a number value from event data
export function getNumberValue(
  event: FlexibleEventData,
  key: string,
): number | undefined {
  const value = event[key];
  return typeof value === "number" ? value : undefined;
}

// Helper to check if fields contain aggregate functions
export function isAggregateQuery(fields: string[]): boolean {
  return fields.some((field) => field.includes("(") && field.includes(")"));
}

export function looksLikeSentrySearchSyntax(query?: string): boolean {
  const trimmedQuery = query?.trim();
  if (!trimmedQuery) {
    return false;
  }

  for (const match of trimmedQuery.matchAll(SENTRY_SEARCH_TOKEN_PATTERN)) {
    const key = match[2];
    if (!key) {
      continue;
    }

    if (/^tags\[[^\]]+\]$/.test(key)) {
      return true;
    }

    if (key !== key.toLowerCase()) {
      continue;
    }

    if (KNOWN_SENTRY_SEARCH_KEYS.has(key) || /[.[\],]/.test(key)) {
      return true;
    }

    if (/^[a-z_][a-z0-9_-]*$/.test(key)) {
      return true;
    }
  }

  return false;
}

const FULL_TEXT_SEARCH_KEYS = new Set(["message", "log.body"]);

/**
 * Replace quoted regions with same-length placeholders so colons inside quotes
 * are not treated as filter-key separators (e.g. transaction:"handle message:hello").
 * Length is preserved so offsets still map back to the original query.
 */
function maskQuotedRegions(query: string): string {
  let out = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const char of query) {
    if (escaped) {
      escaped = false;
      out += quote ? "x" : char;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      out += quote ? "x" : char;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
        out += char;
      } else {
        // Keep length; neutralize token separators inside quotes.
        out += char === ":" || /\s/.test(char) ? "x" : char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      out += char;
      continue;
    }
    out += char;
  }

  return out;
}

type SearchFilterOccurrence = {
  key: string;
  value: string;
};

function normalizeFilterValue(rawValue: string): string {
  return rawValue
    .replace(/^['"]|['"]$/g, "")
    .replace(/^\*+|\*+$/g, "")
    .trim()
    .toLowerCase();
}

/**
 * Read one filter value starting at `valueStart` in the original query.
 * Quoted values keep interior whitespace; unquoted values stop at whitespace.
 */
function readRawFilterValue(
  query: string,
  valueStart: number,
): string | undefined {
  if (valueStart >= query.length) {
    return undefined;
  }

  const first = query[valueStart];
  if (first === '"' || first === "'") {
    let escaped = false;
    for (let i = valueStart + 1; i < query.length; i += 1) {
      const char = query[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === first) {
        return query.slice(valueStart, i + 1);
      }
    }
    // Unclosed quote: take the remainder so comparison still sees later words.
    return query.slice(valueStart);
  }

  const valueMatch = query.slice(valueStart).match(/^\S+/);
  return valueMatch?.[0];
}

/**
 * Extract every field:value occurrence while preserving multiplicity and quote
 * boundaries. Values are normalized for comparison (strip wrapping quotes and
 * leading/trailing wildcards).
 */
function searchFilterOccurrences(query: string): SearchFilterOccurrence[] {
  const occurrences: SearchFilterOccurrence[] = [];
  const masked = maskQuotedRegions(query);

  for (const match of masked.matchAll(SENTRY_SEARCH_TOKEN_PATTERN)) {
    const key = match[2]?.toLowerCase();
    if (!key || match.index === undefined) {
      continue;
    }

    // Read the real value from the original query at the same offset so quotes
    // and multi-word quoted values are preserved before normalization.
    const valueStart = match.index + match[0].indexOf(":") + 1;
    const rawValue = readRawFilterValue(query, valueStart);
    if (!rawValue) {
      continue;
    }

    const value = normalizeFilterValue(rawValue);
    if (!value) {
      continue;
    }

    occurrences.push({ key, value });
  }

  return occurrences;
}

function structuredFilterOccurrences(query: string): SearchFilterOccurrence[] {
  return searchFilterOccurrences(query).filter(
    (occurrence) => !FULL_TEXT_SEARCH_KEYS.has(occurrence.key),
  );
}

function fullTextFilterValues(query: string): string[] {
  return searchFilterOccurrences(query)
    .filter((occurrence) => FULL_TEXT_SEARCH_KEYS.has(occurrence.key))
    .map((occurrence) => occurrence.value);
}

function filterOccurrenceIdentity(occurrence: SearchFilterOccurrence): string {
  return `${occurrence.key}\0${occurrence.value}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when `needle` appears in `haystack` as a whole token, not a bare
 * substring. Prevents `id:1` from matching inside `message:"error 401"`.
 */
function containsAsWholeToken(haystack: string, needle: string): boolean {
  if (!haystack || !needle) {
    return false;
  }
  if (haystack === needle) {
    return true;
  }

  const escaped = escapeRegExp(needle);
  // Token edges are start/end or a non-alphanumeric/underscore char so short
  // numeric fragments cannot match inside longer numbers.
  return new RegExp(`(?:^|[^A-Za-z0-9_])${escaped}(?:$|[^A-Za-z0-9_])`).test(
    haystack,
  );
}

function isRelatedFilterValue(left: string, right: string): boolean {
  return containsAsWholeToken(left, right) || containsAsWholeToken(right, left);
}

/**
 * Structured filters present in `original` that are not covered by multiset
 * cardinality in `repaired` (same key+value pair counts).
 */
function unmatchedStructuredFilters(
  original: SearchFilterOccurrence[],
  repaired: SearchFilterOccurrence[],
): SearchFilterOccurrence[] {
  const remaining = new Map<string, number>();
  for (const occurrence of repaired) {
    const identity = filterOccurrenceIdentity(occurrence);
    remaining.set(identity, (remaining.get(identity) ?? 0) + 1);
  }

  const unmatched: SearchFilterOccurrence[] = [];
  for (const occurrence of original) {
    const identity = filterOccurrenceIdentity(occurrence);
    const count = remaining.get(identity) ?? 0;
    if (count > 0) {
      remaining.set(identity, count - 1);
      continue;
    }
    unmatched.push(occurrence);
  }

  return unmatched;
}

/**
 * True when a structured field:value filter was replaced with message/log.body
 * full-text matching (false-success path). Allows real attribute renames.
 *
 * Uses multiset key+value matching so dropping one of several identical keys
 * (e.g. `custom:foo custom:bar` → `custom:bar message:"*foo*"`) is still caught.
 * Value comparison is whole-token, not bare substring, so unrelated full-text
 * (e.g. `id:1` vs `message:"error 401"`) is not treated as a downgrade.
 */
export function isSemanticFilterDowngrade(
  originalQuery: string,
  repairedQuery: string,
): boolean {
  if (!looksLikeSentrySearchSyntax(originalQuery)) {
    return false;
  }

  const originalFilters = structuredFilterOccurrences(originalQuery);
  if (originalFilters.length === 0) {
    return false;
  }

  const repairedFilters = structuredFilterOccurrences(repairedQuery);
  const droppedFilters = unmatchedStructuredFilters(
    originalFilters,
    repairedFilters,
  );
  if (droppedFilters.length === 0) {
    return false;
  }

  const repairedFullTextValues = fullTextFilterValues(repairedQuery);
  if (repairedFullTextValues.length === 0) {
    // Renames keep values on non-full-text attributes and do not need this guard.
    return false;
  }

  return droppedFilters.some((filter) =>
    repairedFullTextValues.some((fullTextValue) =>
      isRelatedFilterValue(filter.value, fullTextValue),
    ),
  );
}

function isPrimitive(
  value: unknown,
): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isTagPair(value: unknown): value is { key: string; value: unknown } {
  return (
    isPlainObject(value) && typeof value.key === "string" && "value" in value
  );
}

const USER_FIELDS = [
  "id",
  "email",
  "username",
  "ip_address",
  "name",
  "display_name",
] as const;
const USER_IDENTITY_FIELDS = new Set([
  "email",
  "username",
  "ip_address",
  "name",
  "display_name",
]);

function hasUserIdentityFields(value: Record<string, unknown>): boolean {
  return USER_FIELDS.some(
    (f) => USER_IDENTITY_FIELDS.has(f) && value[f] != null,
  );
}

function hasUserSummaryFields(
  value: Record<string, unknown>,
  options: { allowId?: boolean } = {},
): boolean {
  return (
    hasUserIdentityFields(value) ||
    (options.allowId === true && value.id != null)
  );
}

function formatUserSummary(
  value: Record<string, unknown>,
  options: {
    includeGeo?: boolean;
    allowIdOnly?: boolean;
  } = {},
): string | null {
  const includeGeo = options.includeGeo ?? true;
  const allowIdOnly = options.allowIdOnly ?? false;
  // Require at least one identity field to avoid matching arbitrary objects that just have "id"
  const hasSummaryField = hasUserSummaryFields(value, { allowId: allowIdOnly });
  if (!hasSummaryField) {
    return null;
  }

  const parts = USER_FIELDS.filter((f) => value[f] != null).map(
    (f) => `${f}=${formatSimpleValue(value[f])}`,
  );
  const geoSummary = formatUserGeoSummary(value.geo);
  if (includeGeo && geoSummary) {
    parts.push(`geo=${geoSummary}`);
  }

  return parts.length > 0 ? parts.join(", ") : null;
}

export function formatKnownUserValue(
  value: Record<string, unknown>,
  options: { includeGeo?: boolean } = {},
): string | null {
  return formatUserSummary(value, {
    includeGeo: options.includeGeo,
    allowIdOnly: true,
  });
}

function sanitizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength <= 3) {
    return value.slice(0, maxLength);
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, currentValue) => {
    if (typeof currentValue === "bigint") {
      return currentValue.toString();
    }

    if (typeof currentValue === "function") {
      return "[Function]";
    }

    if (typeof currentValue === "object" && currentValue !== null) {
      if (seen.has(currentValue)) {
        return "[Circular]";
      }
      seen.add(currentValue);
    }

    return currentValue;
  });
}

function formatSimpleValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";

  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return safeJsonStringify(value);
}

function formatArrayValue(values: unknown[], maxLength: number): string {
  if (values.length === 0) {
    return "[]";
  }

  if (values.every(isTagPair)) {
    const pairs = values.map(
      (tag) => `${tag.key}=${formatSimpleValue(tag.value)}`,
    );
    return truncateString(sanitizeWhitespace(pairs.join(", ")), maxLength);
  }

  if (values.every(isPrimitive)) {
    return truncateString(
      sanitizeWhitespace(values.map((value) => String(value)).join(", ")),
      maxLength,
    );
  }

  const overflow = values.length > DEFAULT_MAX_ARRAY_ITEMS;
  const limitedValues = overflow
    ? values.slice(0, DEFAULT_MAX_ARRAY_ITEMS)
    : values;
  const jsonValue = safeJsonStringify(limitedValues);
  const suffix = overflow
    ? `, ...+${values.length - DEFAULT_MAX_ARRAY_ITEMS} more`
    : "";

  return truncateString(sanitizeWhitespace(`${jsonValue}${suffix}`), maxLength);
}

function formatObjectValue(
  value: Record<string, unknown>,
  maxLength: number,
): string {
  // Check tag pair first -- it's more specific than the user summary heuristic
  if (isTagPair(value)) {
    return truncateString(
      sanitizeWhitespace(`${value.key}=${formatSimpleValue(value.value)}`),
      maxLength,
    );
  }

  const userSummary = formatUserSummary(value);
  if (userSummary) {
    return truncateString(sanitizeWhitespace(userSummary), maxLength);
  }

  return truncateString(
    sanitizeWhitespace(safeJsonStringify(value)),
    maxLength,
  );
}

export function formatEventValue(
  value: unknown,
  options: {
    maxLength?: number;
  } = {},
): string {
  const maxLength = options.maxLength ?? DEFAULT_MAX_VALUE_LENGTH;

  if (value === null) return "null";
  if (value === undefined) return "undefined";

  if (typeof value === "string") {
    return truncateString(sanitizeWhitespace(value), maxLength);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return formatArrayValue(value, maxLength);
  }

  if (isPlainObject(value)) {
    return formatObjectValue(value, maxLength);
  }

  return truncateString(sanitizeWhitespace(String(value)), maxLength);
}

// Helper function to fetch custom attributes for a dataset
export async function fetchCustomAttributes(
  apiService: SentryApiService,
  organizationSlug: string,
  dataset: EventsDataset,
  projectId?: string,
  timeParams?: { statsPeriod?: string; start?: string; end?: string },
  options: {
    attributeTypes?: TraceItemAttributeType[];
    substringMatch?: string;
    query?: string;
  } = {},
): Promise<{
  attributes: Record<string, string>;
  fieldTypes: Record<string, TraceItemAttributeType>;
}> {
  const customAttributes: Record<string, string> = {};
  const fieldTypes: Record<string, TraceItemAttributeType> = {};
  const normalizedDataset = normalizeEventsDataset(dataset);
  const attributeTimeParams = timeParams ?? { statsPeriod: "14d" };

  if (normalizedDataset === "errors") {
    // TODO: For errors dataset, we currently need to use the old listTags API
    // This will be updated in the future to use the new trace-items attributes API
    const tagsResponse = await apiService.listTags({
      organizationSlug,
      dataset: "events",
      project: projectId,
      statsPeriod: attributeTimeParams.statsPeriod,
      start: attributeTimeParams.start,
      end: attributeTimeParams.end,
      useCache: true,
      useFlagsBackend: true,
    });

    for (const tag of tagsResponse) {
      if (tag.key && !tag.key.startsWith("sentry:")) {
        customAttributes[tag.key] = tag.name || tag.key;
      }
    }
  } else if (normalizedDataset === "profiles") {
    // Profiles currently use a stable, product-defined field set rather than
    // the trace-item attributes endpoint.
    return { attributes: customAttributes, fieldTypes };
  } else {
    // For logs, spans, and trace metrics datasets, use the trace-items attributes endpoint
    const itemType = getTraceItemType(normalizedDataset);
    if (!itemType) {
      return { attributes: customAttributes, fieldTypes };
    }

    const attributesResponse = await apiService.listTraceItemAttributes({
      organizationSlug,
      itemType,
      project: projectId,
      statsPeriod: attributeTimeParams.statsPeriod,
      start: attributeTimeParams.start,
      end: attributeTimeParams.end,
      attributeTypes: options.attributeTypes,
      substringMatch: options.substringMatch,
      query: options.query,
    });

    for (const attr of attributesResponse) {
      if (attr.key && !attr.key.startsWith("sentry:")) {
        customAttributes[attr.key] = attr.name || attr.key;
        // Track field type from the attribute response with validation
        if (attr.type) {
          fieldTypes[attr.key] = attr.type;
        }
      }
    }
  }

  return { attributes: customAttributes, fieldTypes };
}

function getTraceItemType(dataset: EventsDataset): TraceItemType | null {
  const normalizedDataset = normalizeEventsDataset(dataset);
  if (normalizedDataset === "logs") {
    return "logs";
  }
  if (normalizedDataset === "tracemetrics") {
    return "tracemetrics";
  }
  if (normalizedDataset === "spans") {
    return "spans";
  }
  return null;
}

function formatValidationStatusLine({
  valid,
  name,
  type,
  error,
  indent = 0,
}: {
  valid: boolean;
  name?: string;
  type?: string;
  error?: string;
  indent?: number;
}): string {
  const status = valid ? "OK" : "INVALID";
  const label = name ? ` ${name}` : "";
  const prefix = `${" ".repeat(indent)}- ${status}${label}`;

  if (valid && type) {
    return `${prefix} — type: ${type}`;
  }
  if (error) {
    return `${prefix} — ${error}`;
  }
  return prefix;
}

function formatQueryValidation(
  query: EventsQueryValidation,
  failuresOnly: boolean,
): string[] {
  const invalidFields = query.fields.filter((field) => !field.valid);
  const visibleFields = failuresOnly ? invalidFields : query.fields;
  const showQueryLine = failuresOnly
    ? !query.valid || invalidFields.length > 0
    : !query.valid || query.fields.length > 0;

  if (!showQueryLine) {
    return [];
  }

  const lines: string[] = [];
  if (!query.valid) {
    lines.push(
      formatValidationStatusLine({
        valid: false,
        name: "query",
        error: query.error,
      }),
    );
  } else {
    lines.push(formatValidationStatusLine({ valid: true, name: "query" }));
  }

  lines.push(
    ...visibleFields.map((field) =>
      formatValidationStatusLine({ ...field, indent: 2 }),
    ),
  );
  return lines;
}

function pushValidationSection(
  sections: string[],
  title: string,
  items: ReadonlyArray<{
    valid: boolean;
    name?: string;
    type?: string;
    error?: string;
  }>,
  failuresOnly: boolean,
): void {
  const visibleItems = failuresOnly
    ? items.filter((item) => !item.valid)
    : items;
  if (visibleItems.length === 0) {
    return;
  }

  sections.push(
    `Validated ${title}:\n${visibleItems.map((item) => formatValidationStatusLine(item)).join("\n")}`,
  );
}

export function formatEventsValidationResults(
  validationResults: EventsValidationResult,
): string {
  const failuresOnly = !validationResults.valid;
  const sections: string[] = [];

  pushValidationSection(
    sections,
    "Projects",
    validationResults.projects,
    failuresOnly,
  );
  pushValidationSection(
    sections,
    "Dataset",
    validationResults.dataset,
    failuresOnly,
  );
  pushValidationSection(
    sections,
    "Environment",
    validationResults.environment,
    failuresOnly,
  );
  pushValidationSection(
    sections,
    "Fields",
    validationResults.field,
    failuresOnly,
  );

  const queryLines = formatQueryValidation(
    validationResults.query,
    failuresOnly,
  );
  if (queryLines.length > 0) {
    sections.push(`Validated Query:\n${queryLines.join("\n")}`);
  }

  pushValidationSection(
    sections,
    "Order By",
    validationResults.orderby,
    failuresOnly,
  );

  if (sections.length === 0) {
    return "";
  }

  const overall = validationResults.valid ? "valid" : "invalid";
  const details = sections.join("\n\n");
  return `Validation Result: ${overall}\n${details}\n`;
}

const VALIDATION_OUTPUT_MAX_LENGTH = 1024;

function truncateValidationOutput(output: string): string {
  if (output.length <= VALIDATION_OUTPUT_MAX_LENGTH) {
    return output;
  }
  return `${output.slice(0, VALIDATION_OUTPUT_MAX_LENGTH)}…`;
}

export function recordEventsSearchValidationTelemetry({
  attempt,
  repairIteration,
  validation,
}: {
  attempt: number;
  repairIteration?: number;
  validation: EventsValidationResult;
}): void {
  const span = getActiveSpan();
  if (!span) {
    return;
  }

  span.setAttribute("app.search_events.validation.attempt", attempt);
  span.setAttribute("app.search_events.validation.valid", validation.valid);
  if (repairIteration !== undefined) {
    span.setAttribute(
      "app.search_events.validation.repair_iteration",
      repairIteration,
    );
  }

  const formatted = formatEventsValidationResults(validation);
  if (formatted) {
    span.setAttribute(
      "app.search_events.validation.output",
      truncateValidationOutput(formatted),
    );
  }
}

export async function validateEventsSearch(
  apiService: SentryApiService,
  {
    organizationSlug,
    dataset,
    fields,
    query,
    sort,
    projectId,
    environment,
    statsPeriod,
    start,
    end,
  }: {
    organizationSlug: string;
    dataset: EventsDataset;
    fields: string[];
    query: string;
    sort: string;
    projectId?: string;
    environment?: string | string[];
    statsPeriod?: string;
    start?: string;
    end?: string;
  },
): Promise<EventsValidationResult> {
  return apiService.validateEvents({
    organizationSlug,
    dataset,
    fields,
    query,
    orderby: [sort],
    project: projectId,
    environment,
    statsPeriod,
    start,
    end,
  });
}

export async function assertEventsSearchIsValid(
  apiService: SentryApiService,
  {
    organizationSlug,
    dataset,
    fields,
    query,
    sort,
    projectId,
    environment,
    statsPeriod,
    start,
    end,
  }: {
    organizationSlug: string;
    dataset: EventsDataset;
    fields: string[];
    query: string;
    sort: string;
    projectId?: string;
    environment?: string | string[];
    statsPeriod?: string;
    start?: string;
    end?: string;
  },
): Promise<void> {
  const validationResults = await validateEventsSearch(apiService, {
    organizationSlug,
    dataset,
    fields,
    query,
    sort,
    projectId,
    environment,
    statsPeriod,
    start,
    end,
  });

  if (!validationResults.valid) {
    const formatted = formatEventsValidationResults(validationResults);
    throw new UserInputError(
      formatted
        ? `Search validation failed:\n${formatted}`
        : "Search validation failed.",
    );
  }
}

/**
 * Create a tool for the agent to query available attributes by dataset
 * The tool is pre-bound with the API service and organization configured for the appropriate region
 */
export function createDatasetAttributesTool(options: {
  apiService: SentryApiService;
  organizationSlug: string;
  projectId?: string;
}) {
  const { apiService, organizationSlug, projectId } = options;
  const traceItemAttributeTypeSchema = z.enum(["string", "number", "boolean"]);

  return agentTool({
    description:
      "Query and filter available attributes and fields for a specific Sentry dataset to understand what data is available",
    parameters: z.object({
      dataset: z
        .enum(PUBLIC_EVENTS_DATASETS)
        .describe("The dataset to query attributes for"),
      substringMatch: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("Optional substring to find matching attribute names"),
      query: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          "Optional Sentry search query to list attributes available for that filtered result set",
        ),
      attributeTypes: z
        .array(traceItemAttributeTypeSchema)
        .min(1)
        .optional()
        .describe(
          "Optional attribute types to list. Use ['string','number','boolean'] when unsure.",
        ),
    }),
    execute: async ({ dataset, substringMatch, query, attributeTypes }) => {
      const {
        BASE_COMMON_FIELDS,
        DATASET_FIELDS,
        RECOMMENDED_FIELDS,
        NUMERIC_FIELDS,
        DATASET_EXAMPLES,
      } = await import("./config");

      // Get custom attributes for this dataset
      // IMPORTANT: Let ALL errors bubble up to wrapAgentToolExecute
      // UserInputError will be converted to error string for the AI agent
      // Other errors will bubble up to be captured by Sentry
      const normalizedDataset = normalizeEventsDataset(dataset);
      const attributeTimeParams = { statsPeriod: "14d" };
      const { attributes: customAttributes, fieldTypes } =
        await fetchCustomAttributes(
          apiService,
          organizationSlug,
          dataset,
          projectId,
          attributeTimeParams,
          {
            attributeTypes,
            substringMatch,
            query,
          },
        );

      // Combine all available fields
      const allFields = {
        ...BASE_COMMON_FIELDS,
        ...DATASET_FIELDS[normalizedDataset],
        ...customAttributes,
      };
      const fieldCount = Object.keys(allFields).length;

      const recommendedFields = RECOMMENDED_FIELDS[normalizedDataset];

      // Combine field types from both static config and dynamic API
      const allFieldTypes: Record<string, TraceItemAttributeType> = {
        ...fieldTypes,
      };
      const staticNumericFields =
        NUMERIC_FIELDS[normalizedDataset] || new Set();
      for (const field of staticNumericFields) {
        allFieldTypes[field] = "number";
      }

      recordAgentToolResultCount(fieldCount);

      return `Dataset: ${dataset}

Available Fields (${fieldCount} total):
${Object.entries(allFields)
  .slice(0, 50) // Limit to first 50 to avoid overwhelming the agent
  .map(([key, desc]) => `- ${key}: ${desc}`)
  .join("\n")}
${fieldCount > 50 ? `\n... and ${fieldCount - 50} more fields` : ""}

Recommended Fields for ${dataset}:
${recommendedFields.basic.map((f) => `- ${f}`).join("\n")}

Field Types (CRITICAL for aggregate functions):
${Object.entries(allFieldTypes)
  .slice(0, 30) // Show more field types since this is critical for aggregate functions
  .map(([key, type]) => `- ${key}: ${type}`)
  .join("\n")}
${Object.keys(allFieldTypes).length > 30 ? `\n... and ${Object.keys(allFieldTypes).length - 30} more fields` : ""}

IMPORTANT: Only use numeric aggregate functions (avg, sum, min, max, percentiles) with numeric fields. Use count() or count_unique() for non-numeric fields.

EXAMPLE QUERIES FOR ${dataset.toUpperCase()}:
${DATASET_EXAMPLES[normalizedDataset]
  .map((ex) => `- "${ex.description}" →\n  ${JSON.stringify(ex.output)}`)
  .join("\n\n")}

Use these examples as patterns for constructing your query.`;
    },
  });
}

/**
 * Create a tool for the agent to validate a candidate events search before returning.
 * Prefer this over external try/fail/retry orchestration in the tool handler.
 */
export function createValidateEventsSearchTool(options: {
  apiService: SentryApiService;
  organizationSlug: string;
  projectId?: string;
}) {
  const { apiService, organizationSlug, projectId } = options;

  return agentTool({
    description:
      "Validate a candidate Sentry events search before returning it. Call this after constructing dataset/query/fields/sort. If invalid, fix the request and validate again. Never replace a structured field:value filter with message/log.body full-text matching.",
    parameters: z.object({
      dataset: z
        .enum(PUBLIC_EVENTS_DATASETS)
        .describe("Dataset for the candidate search"),
      query: z
        .string()
        .describe("Candidate Sentry search query string (may be empty)"),
      fields: z
        .array(z.string())
        .min(1)
        .describe(
          "Candidate fields, including any aggregate functions and sort field",
        ),
      sort: z.string().min(1).describe("Candidate sort parameter"),
      statsPeriod: z
        .string()
        .optional()
        .describe("Optional relative time period like 1h, 24h, 7d"),
      start: z.string().optional().describe("Optional ISO 8601 start time"),
      end: z.string().optional().describe("Optional ISO 8601 end time"),
    }),
    execute: async ({
      dataset,
      query,
      fields,
      sort,
      statsPeriod,
      start,
      end,
    }) => {
      const validation = await validateEventsSearch(apiService, {
        organizationSlug,
        dataset,
        fields,
        query,
        sort,
        projectId,
        statsPeriod,
        start,
        end,
      });

      recordEventsSearchValidationTelemetry({
        attempt: 0,
        validation,
      });

      if (validation.valid) {
        return {
          valid: true,
          message: "Search validation passed.",
        };
      }

      const formatted = formatEventsValidationResults(validation);
      return {
        valid: false,
        message: formatted
          ? `Search validation failed:\n${formatted}`
          : "Search validation failed.",
      };
    },
  });
}
