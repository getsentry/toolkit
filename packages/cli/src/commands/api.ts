/**
 * sentry api
 *
 * Make raw authenticated API requests to Sentry.
 * Similar to 'gh api' for GitHub.
 */

import { access, readFile } from "node:fs/promises";
// biome-ignore lint/performance/noNamespaceImport: Sentry SDK recommends namespace import
import * as Sentry from "@sentry/node-core/light";
import type { SentryContext } from "../context.js";
import { appendSearchParams, rawApiRequest } from "../lib/api-client.js";
import { buildCommand } from "../lib/command.js";
import { OutputError, ValidationError } from "../lib/errors.js";
import { filterFields } from "../lib/formatters/json.js";
import { CommandOutput } from "../lib/formatters/output.js";
import { validateEndpoint } from "../lib/input-validation.js";
import { imageBytesToKitty } from "../lib/kitty-image.js";
import { logger } from "../lib/logger.js";
import { getDefaultSdkConfig, getSdkConfig } from "../lib/sentry-client.js";
import {
  canRenderKitty,
  canRenderSixel,
  terminalPixelWidth,
} from "../lib/sixel.js";
import { imageBytesToSixel } from "../lib/sixel-image.js";
import { setOrgProjectContext } from "../lib/telemetry.js";

const log = logger.withTag("api");

/** Strips line breaks and surrounding indentation from copy-pasted endpoints. */
const LINE_BREAK_PATTERN = /[ \t]*[\r\n]+[ \t]*/g;
const API_PREFIX = "/api/0";
const API_PREFIX_WITH_SLASH = `${API_PREFIX}/`;

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

type ApiFlags = {
  readonly method: HttpMethod;
  readonly data?: string;
  readonly field?: string[];
  readonly "raw-field"?: string[];
  readonly header?: string[];
  readonly input?: string;
  readonly silent: boolean;
  readonly verbose: boolean;
  readonly "dry-run": boolean;
  /** Injected by buildCommand via output config */
  readonly json: boolean;
  /** Injected by buildCommand via output config */
  readonly fields?: string[];
};

// Request Parsing

const VALID_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "DELETE", "PATCH"];

/**
 * Read all data from stdin as a string.
 * Uses Bun's native stream handling for efficiency.
 * @internal Exported for testing
 */
export async function readStdin(
  stdin: NodeJS.ReadStream & { fd: 0 }
): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of stdin) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Parse and validate HTTP method from string.
 *
 * @param value - HTTP method string (case-insensitive)
 * @returns Normalized uppercase HTTP method
 * @throws {Error} When method is not one of GET, POST, PUT, DELETE, PATCH
 * @internal Exported for testing
 */
export function parseMethod(value: string): HttpMethod {
  const upper = value.toUpperCase();
  if (!VALID_METHODS.includes(upper as HttpMethod)) {
    throw new Error(
      `Invalid method: ${value}. Must be one of: ${VALID_METHODS.join(", ")}`
    );
  }
  return upper as HttpMethod;
}

/**
 * Parse an absolute HTTP(S) API URL.
 */
function parseAbsoluteApiUrl(endpoint: string): URL | undefined {
  const lowerEndpoint = endpoint.toLowerCase();
  if (
    !(
      lowerEndpoint.startsWith("http://") ||
      lowerEndpoint.startsWith("https://")
    )
  ) {
    return;
  }
  try {
    return new URL(endpoint);
  } catch {
    throw new ValidationError("Invalid absolute API URL", "endpoint");
  }
}

type AbsoluteApiTarget = {
  endpoint: string;
  baseUrl: string;
  strippedApiPrefix: boolean;
};

function splitAbsoluteApiUrl(url: URL): AbsoluteApiTarget {
  const prefixIndex = url.pathname.indexOf(API_PREFIX_WITH_SLASH);
  if (prefixIndex !== -1) {
    return {
      endpoint: `${url.pathname.slice(prefixIndex + API_PREFIX_WITH_SLASH.length)}${url.search}`,
      baseUrl: `${url.origin}${url.pathname.slice(0, prefixIndex)}`,
      strippedApiPrefix: true,
    };
  }
  if (url.pathname.endsWith(API_PREFIX)) {
    return {
      endpoint: url.search,
      baseUrl: `${url.origin}${url.pathname.slice(0, -API_PREFIX.length)}`,
      strippedApiPrefix: true,
    };
  }
  return {
    endpoint: `${url.pathname}${url.search}`,
    baseUrl: url.origin,
    strippedApiPrefix: false,
  };
}

/**
 * Normalize an API endpoint to ensure the path has a trailing slash.
 * Sentry API requires trailing slashes on endpoints.
 * Handles query strings correctly by only modifying the path portion.
 *
 * Accepts paths relative to `/api/0/` and absolute HTTP(S) URLs.
 *
 * @param endpoint - API endpoint path or absolute URL (may include query string)
 * @returns Endpoint with trailing slash on path, query string preserved
 * @internal Exported for testing
 */
export function normalizeEndpoint(endpoint: string): string {
  // Strip line breaks and surrounding indentation from copy-pasted
  // endpoints. Users often paste multi-line URLs from docs or scripts,
  // producing newlines and indentation (CLI-FR, 215 events).
  // Other control characters (NUL, etc.) are left for validateEndpoint
  // to reject — those indicate corruption, not copy-paste.
  const rawEndpoint = endpoint.replace(LINE_BREAK_PATTERN, "").trim();
  if (rawEndpoint !== endpoint) {
    log.warn("Stripped line breaks from endpoint (copy-paste artifact)");
  }

  // Stage 1: validate the caller's representation before WHATWG URL parsing
  // can normalize dot segments away.
  validateEndpoint(rawEndpoint);

  // Absolute Sentry API URLs (from `attachments[].download` or copy-paste)
  // collapse to a path relative to /api/0/. The command retains the base URL
  // separately when it executes the request.
  const absoluteUrl = parseAbsoluteApiUrl(rawEndpoint);
  const relativeEndpoint = absoluteUrl
    ? splitAbsoluteApiUrl(absoluteUrl).endpoint
    : rawEndpoint;

  // Stage 2: validate the transformed path that rawApiRequest will receive
  // after origin and API-prefix extraction.
  validateEndpoint(relativeEndpoint);

  // Remove leading slash if present (rawApiRequest handles the base URL)
  let trimmed = relativeEndpoint.startsWith("/")
    ? relativeEndpoint.slice(1)
    : relativeEndpoint;

  // Strip api/0/ prefix if user accidentally included it — the base URL
  // already includes /api/0/, so keeping it would produce a doubled path
  // like /api/0/api/0/... (see CLI-K1).
  // Also strip bare "api/0" to maintain idempotency.
  if (trimmed.startsWith("api/0/") || trimmed === "api/0") {
    trimmed = trimmed.slice(trimmed.startsWith("api/0/") ? 6 : 5);
  }

  // Split path and query string
  const queryIndex = trimmed.indexOf("?");
  if (queryIndex === -1) {
    // No query string - just ensure trailing slash
    return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
  }

  // Has query string - add trailing slash to path only
  const path = trimmed.substring(0, queryIndex);
  const query = trimmed.substring(queryIndex);
  const normalizedPath = path.endsWith("/") ? path : `${path}/`;
  return `${normalizedPath}${query}`;
}

function resolveApiTarget(endpoint: string): {
  normalizedEndpoint: string;
  requestBaseUrl?: string;
  strippedApiPrefix: boolean;
} {
  const cleaned = endpoint.replace(LINE_BREAK_PATTERN, "").trim();
  const absoluteUrl = parseAbsoluteApiUrl(cleaned);
  const absoluteTarget = absoluteUrl
    ? splitAbsoluteApiUrl(absoluteUrl)
    : undefined;
  const comparableEndpoint = absoluteTarget?.endpoint ?? cleaned;
  const withoutLeadingSlash = comparableEndpoint.startsWith("/")
    ? comparableEndpoint.slice(1)
    : comparableEndpoint;
  return {
    normalizedEndpoint: normalizeEndpoint(endpoint),
    requestBaseUrl: absoluteTarget?.baseUrl,
    strippedApiPrefix:
      absoluteTarget?.strippedApiPrefix ??
      (withoutLeadingSlash.startsWith("api/0/") ||
        withoutLeadingSlash === "api/0"),
  };
}

/**
 * Org/project slugs or numeric IDs in API paths. Rejects schema placeholders
 * (`{organization_id_or_slug}`) and empty/dot segments so we never tag junk.
 */
const API_PATH_SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function isApiPathSlug(segment: string | undefined): segment is string {
  return segment !== undefined && API_PATH_SLUG_RE.test(segment);
}

/**
 * Parse org (and project when present) from a Sentry API endpoint path.
 *
 * `sentry api` never goes through target resolve, so the slug lives only in
 * the URL. `organizations/`, `projects/`, and `teams/` prefixes carry the
 * org; `projects/` and `organizations/{org}/projects/{project}/` also carry
 * a project when that segment is a real slug.
 *
 * @param endpoint - Path relative to `/api/0/`, optionally with a query string
 *   or a leading `/api/0/` prefix
 * @returns Org (and project when present), or `undefined` when the path is
 *   unscoped, a list endpoint, or a schema placeholder
 * @internal Exported for testing
 */
export function parseOrgProjectFromApiPath(
  endpoint: string
): { org: string; project?: string } | undefined {
  const path = endpoint.split("?", 1)[0] ?? "";
  const segments = path.split("/").filter((segment) => segment.length > 0);

  if (segments[0] === "api" && segments[1] === "0") {
    segments.splice(0, 2);
  }

  if (segments[0] === "organizations" && isApiPathSlug(segments[1])) {
    const org = segments[1];
    if (segments[2] === "projects" && isApiPathSlug(segments[3])) {
      return { org, project: segments[3] };
    }
    return { org };
  }

  if (segments[0] === "projects" && isApiPathSlug(segments[1])) {
    const org = segments[1];
    if (isApiPathSlug(segments[2])) {
      return { org, project: segments[2] };
    }
    return { org };
  }

  if (segments[0] === "teams" && isApiPathSlug(segments[1])) {
    return { org: segments[1] };
  }

  return;
}

function tagOrgFromApiPath(endpoint: string): void {
  const parsed = parseOrgProjectFromApiPath(endpoint);
  if (parsed) {
    setOrgProjectContext([parsed.org], parsed.project ? [parsed.project] : []);
  }
}

/**
 * Parse a field value, attempting JSON parse first.
 *
 * @param value - Raw string value to parse
 * @returns Parsed JSON value, or original string if not valid JSON
 * @internal Exported for testing
 */
export function parseFieldValue(value: string): unknown {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Keys that could cause prototype pollution if used in nested object assignment */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Regex to match field key format: baseKey followed by zero or more [bracket] segments */
const FIELD_KEY_REGEX = /^([^[\]]+)((?:\[[^[\]]*\])*)$/;

/** Regex to extract bracket contents from a field key */
const BRACKET_CONTENTS_REGEX = /\[([^[\]]*)\]/g;

/**
 * Parse a field key into path segments.
 * Supports bracket notation: "user[name]" -> ["user", "name"]
 * Supports array syntax: "tags[]" -> ["tags", ""]
 * Supports deep nesting: "a[b][c]" -> ["a", "b", "c"]
 *
 * @param key - Field key with optional bracket notation
 * @returns Array of path segments
 * @throws {Error} When key format is invalid
 * @internal Exported for testing
 */
export function parseFieldKey(key: string): string[] {
  const match = key.match(FIELD_KEY_REGEX);
  if (!match?.[1]) {
    throw new ValidationError(`Invalid field key format: ${key}`, "field");
  }

  const baseKey = match[1];
  const brackets = match[2] ?? "";

  // Extract bracket contents: "[name][age]" -> ["name", "age"]
  // Empty brackets [] result in empty string "" for array push
  const segments: string[] = brackets
    ? [...brackets.matchAll(BRACKET_CONTENTS_REGEX)].map((m) => m[1] ?? "")
    : [];

  return [baseKey, ...segments];
}

/**
 * Validate path segments for security and correctness.
 * @throws {Error} When a segment is __proto__, constructor, or prototype
 * @throws {Error} When empty brackets appear before the last segment (e.g., a[][b])
 */
function validatePathSegments(path: string[]): void {
  for (let i = 0; i < path.length; i++) {
    const segment = path[i] as string; // Safe: loop bounds guarantee index exists

    // Check for prototype pollution
    if (DANGEROUS_KEYS.has(segment)) {
      throw new ValidationError(
        `Invalid field key: "${segment}" is not allowed`,
        "field"
      );
    }

    // Empty brackets ("") are only valid at the end of the path (array push syntax)
    // Reject patterns like a[][b] which would silently lose data
    if (segment === "" && i < path.length - 1) {
      throw new ValidationError(
        "Invalid field key: empty brackets [] can only appear at the end of a key",
        "field"
      );
    }
  }
}

/**
 * Get a human-readable type name for error messages.
 * Returns "array" for arrays, "map" for objects, and typeof for primitives.
 */
function getTypeName(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value !== null && typeof value === "object") {
    return "map";
  }
  return typeof value;
}

/**
 * Format path segments into a bracket-notation string for error messages.
 * E.g., ["user", "name"] at index 1 -> "user[name]"
 */
function formatPathForError(path: string[], endIndex: number): string {
  const segments = path.slice(0, endIndex + 1);
  if (segments.length === 1) {
    return segments[0] ?? "";
  }
  return `${segments[0]}[${segments.slice(1).join("][")}]`;
}

/**
 * Check if value can be traversed into (is a plain object, not array or primitive).
 */
function isTraversableObject(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate that existing value is compatible with expected traversal type.
 * @throws {Error} When type conflict is detected
 */
function validateTypeCompatibility(
  existing: unknown,
  expectsArray: boolean,
  path: string[],
  index: number
): void {
  const pathStr = formatPathForError(path, index);

  if (expectsArray && !Array.isArray(existing)) {
    throw new ValidationError(
      `expected array type under "${pathStr}", got ${getTypeName(existing)}`,
      "field"
    );
  }

  if (!(expectsArray || isTraversableObject(existing))) {
    throw new ValidationError(
      `expected map type under "${pathStr}", got ${getTypeName(existing)}`,
      "field"
    );
  }
}

/**
 * Navigate/create nested structure to the parent of the target key.
 * @returns The object/array that will contain the final value
 * @throws {Error} When attempting to traverse into a non-object (type conflict)
 */
function navigateToParent(
  obj: Record<string, unknown>,
  path: string[]
): unknown {
  let current: unknown = obj;

  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i] as string; // Safe: loop bounds guarantee index exists
    const nextSegment = path[i + 1] as string;

    // Empty segment only at end for arrays - skip if encountered mid-path
    if (segment === "") {
      continue;
    }

    const currentObj = current as Record<string, unknown>;
    const expectsArray = nextSegment === "";

    if (Object.hasOwn(currentObj, segment)) {
      validateTypeCompatibility(currentObj[segment], expectsArray, path, i);
    } else {
      currentObj[segment] = expectsArray ? [] : {};
    }

    current = currentObj[segment];
  }

  return current;
}

/**
 * Set a nested value in an object using bracket notation key.
 * Creates intermediate objects or arrays as needed.
 *
 * Supports:
 * - Simple keys: "name" -> { name: value }
 * - Nested objects: "user[name]" -> { user: { name: value } }
 * - Deep nesting: "a[b][c]" -> { a: { b: { c: value } } }
 * - Array push: "tags[]" with value -> { tags: [value] }
 * - Empty array: "tags[]" with undefined -> { tags: [] }
 *
 * @param obj - Target object to modify
 * @param key - Bracket-notation key (e.g., "user[name]", "tags[]")
 * @param value - Value to set (undefined for empty array initialization)
 * @throws {Error} When key contains dangerous segments (__proto__, constructor, prototype)
 * @internal Exported for testing
 */
export function setNestedValue(
  obj: Record<string, unknown>,
  key: string,
  value: unknown
): void {
  const path = parseFieldKey(key);
  validatePathSegments(path);

  const current = navigateToParent(obj, path);
  const lastSegment = path.at(-1);

  // Array push syntax: key[]=value
  if (lastSegment === "" && Array.isArray(current) && value !== undefined) {
    current.push(value);
  } else if (lastSegment !== undefined && lastSegment !== "") {
    (current as Record<string, unknown>)[lastSegment] = value;
  }
}

/**
 * Auto-correct fields that use ':' instead of '=' as the separator, and warn
 * the user via the module logger.
 *
 * This recovers from a common mistake where users write Sentry search-query
 * style syntax (`-F status:resolved`) instead of the required key=value form
 * (`-F status=resolved`).  The correction is safe to apply unconditionally
 * because this function is only called for fields that have already been
 * confirmed to contain no '=' — at that point the request would fail anyway.
 *
 * Splitting on the *first* ':' is intentional so that values that themselves
 * contain colons (e.g. ISO timestamps, URLs) are preserved intact:
 *   `since:2026-02-25T11:20:00` → key=`since`, value=`2026-02-25T11:20:00`
 *
 * Fields with no ':' (truly uncorrectable) are returned unchanged so that the
 * downstream parser can throw its normal error.
 *
 * @param fields - Raw field strings from --field or --raw-field flags
 * @returns New array with corrected field strings (or the original array if no
 *   corrections were needed)
 * @internal Exported for testing
 */
export function normalizeFields(
  fields: string[] | undefined
): string[] | undefined {
  if (!fields || fields.length === 0) {
    return fields;
  }

  return fields.map((field) => {
    // Already valid: has '=' or is the empty-array syntax "key[]"
    if (field.includes("=") || field.endsWith("[]")) {
      return field;
    }

    // JSON-shaped strings (starting with { or [) must not be "corrected" —
    // the colon inside is JSON syntax, not a key:value separator.  Let the
    // downstream pipeline handle it (extractJsonBody or processField error).
    if (field.startsWith("{") || field.startsWith("[")) {
      return field;
    }

    const colonIndex = field.indexOf(":");
    // ':' must exist and not be the very first character (that would make an
    // empty key, which the parser rejects regardless)
    if (colonIndex > 0) {
      const key = field.substring(0, colonIndex);
      const value = field.substring(colonIndex + 1);
      const corrected = `${key}=${value}`;
      log.warn(
        `field '${field}' looks like it uses ':' instead of '=' — interpreting as '${corrected}'`
      );
      return corrected;
    }

    // No correction possible; let the downstream parser throw.
    return field;
  });
}

/**
 * Process a single field string and set its value in the result object.
 * @param result - Target object to modify
 * @param field - Field string in "key=value" or "key[]" format
 * @param raw - If true, keep value as string (no JSON parsing)
 * @throws {ValidationError} When field format is invalid
 */
function processField(
  result: Record<string, unknown>,
  field: string,
  raw: boolean
): void {
  const eqIndex = field.indexOf("=");

  // Handle empty array syntax: "key[]" without "="
  if (eqIndex === -1) {
    if (field.endsWith("[]")) {
      setNestedValue(result, field, undefined);
      return;
    }
    throw new ValidationError(
      `Invalid field format: ${field}. Expected key=value`,
      "field"
    );
  }

  const key = field.substring(0, eqIndex);
  const rawValue = field.substring(eqIndex + 1);
  const value = raw ? rawValue : parseFieldValue(rawValue);
  setNestedValue(result, key, value);
}

/**
 * Parse field arguments into request body object.
 * Supports bracket notation for nested keys (e.g., "user[name]=value")
 * and array syntax (e.g., "tags[]=value" or "tags[]" for empty array).
 *
 * @param fields - Array of "key=value" strings (or "key[]" for empty arrays)
 * @param raw - If true, treat all values as strings (no JSON parsing)
 * @returns Parsed object with nested structure
 * @throws {Error} When field format is invalid
 * @internal Exported for testing
 */
export function parseFields(
  fields: string[],
  raw = false
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const field of fields) {
    processField(result, field, raw);
  }

  return result;
}

/**
 * Convert a value to string, JSON-stringifying objects to avoid "[object Object]".
 * @internal
 */
function stringifyValue(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * Build query parameters from typed field strings (--field/-F) for GET requests.
 * Unlike parseFields(), this produces a flat structure suitable for URL query strings.
 * Arrays are represented as string[] for repeated keys (e.g., tags=1&tags=2&tags=3).
 *
 * @param fields - Array of "key=value" strings
 * @returns Record suitable for URLSearchParams
 * @throws {Error} When field doesn't contain "=" or key format is invalid
 * @internal Exported for testing
 */
export function buildQueryParams(
  fields: string[]
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};

  for (const field of fields) {
    const eqIndex = field.indexOf("=");
    if (eqIndex === -1) {
      throw new ValidationError(
        `Invalid field format: ${field}. Expected key=value`,
        "field"
      );
    }

    const key = field.substring(0, eqIndex);

    // Validate key format (same validation as parseFieldKey for consistency)
    if (!FIELD_KEY_REGEX.test(key)) {
      throw new ValidationError(`Invalid field key format: ${key}`, "field");
    }

    const rawValue = field.substring(eqIndex + 1);
    const value = parseFieldValue(rawValue);

    // Handle arrays by creating string[] for repeated keys
    // Use stringifyValue to handle objects (avoid "[object Object]")
    if (Array.isArray(value)) {
      result[key] = value.map(stringifyValue);
    } else {
      result[key] = stringifyValue(value);
    }
  }

  return result;
}

/**
 * Build query parameters from raw field strings (--raw-field/-f) for GET requests.
 * Raw fields are passed directly without any processing (no JSON parsing, no bracket
 * notation, no URI encoding). Values are kept exactly as provided.
 *
 * @param fields - Array of "key=value" strings
 * @returns Record suitable for URLSearchParams
 * @throws {ValidationError} When field doesn't contain "=" or key is empty
 * @internal Exported for testing
 */
export function buildRawQueryParams(
  fields: string[]
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};

  for (const field of fields) {
    const eqIndex = field.indexOf("=");
    if (eqIndex === -1) {
      throw new ValidationError(
        `Invalid field format: ${field}. Expected key=value`,
        "field"
      );
    }

    const key = field.substring(0, eqIndex);
    if (key === "") {
      throw new ValidationError(
        "Invalid field key format: key cannot be empty",
        "field"
      );
    }

    const value = field.substring(eqIndex + 1);

    // For raw fields, handle repeated keys by creating string[]
    const existing = result[key];
    if (existing !== undefined) {
      if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        result[key] = [existing, value];
      }
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Build query parameters from both typed and raw field strings for GET requests.
 * Typed fields (--field/-F) are parsed with JSON conversion and bracket notation.
 * Raw fields (--raw-field/-f) are passed directly without any processing.
 *
 * @param typedFields - Array of typed "key=value" strings (JSON parsed)
 * @param rawFields - Array of raw "key=value" strings (no processing)
 * @returns Merged record suitable for URLSearchParams
 * @internal Exported for testing
 */
export function buildQueryParamsFromFields(
  typedFields?: string[],
  rawFields?: string[]
): Record<string, string | string[]> {
  const typedParams =
    typedFields && typedFields.length > 0 ? buildQueryParams(typedFields) : {};
  const rawParams =
    rawFields && rawFields.length > 0 ? buildRawQueryParams(rawFields) : {};

  // Merge params: raw fields can override typed fields if same key
  return { ...typedParams, ...rawParams };
}

/**
 * Prepare request options by routing fields to body or params based on HTTP method.
 * GET requests send fields as query parameters, other methods send as JSON body.
 *
 * @param method - HTTP method
 * @param typedFields - Array of "key=value" field strings (--field, values parsed as JSON)
 * @param rawFields - Array of "key=value" field strings (--raw-field, values kept as strings)
 * @returns Object with either body or params set (or neither if no fields)
 * @internal Exported for testing
 */
export function prepareRequestOptions(
  method: HttpMethod,
  typedFields?: string[],
  rawFields?: string[]
): {
  body?: Record<string, unknown>;
  params?: Record<string, string | string[]>;
} {
  const hasTypedFields = typedFields && typedFields.length > 0;
  const hasRawFields = rawFields && rawFields.length > 0;
  const hasFields = hasTypedFields || hasRawFields;
  const isBodyMethod = method !== "GET";

  if (!hasFields) {
    return {};
  }

  if (isBodyMethod) {
    // For body methods (POST, PUT, etc.), merge typed and raw fields
    return { body: buildBodyFromFields(typedFields, rawFields) };
  }

  // For GET requests, build query params from both typed and raw fields
  return { params: buildQueryParamsFromFields(typedFields, rawFields) };
}

/**
 * Parse header arguments into headers object.
 *
 * @param headers - Array of "Key: Value" strings
 * @returns Object mapping header names to values
 * @throws {Error} When header doesn't contain ":"
 * @internal Exported for testing
 */
export function parseHeaders(headers: string[]): Record<string, string> {
  const result: Record<string, string> = {};

  for (const header of headers) {
    const colonIndex = header.indexOf(":");
    if (colonIndex === -1) {
      throw new ValidationError(
        `Invalid header format: ${header}. Expected Key: Value`,
        "header"
      );
    }

    const key = header.substring(0, colonIndex).trim();
    const value = header.substring(colonIndex + 1).trim();
    result[key] = value;
  }

  return result;
}

// Request Body Building

/**
 * Parse an inline string as a request body.  Tries JSON first; falls back to
 * the raw string so non-JSON payloads still work.
 *
 * @param data - Raw string from --data flag
 * @returns Parsed JSON object/array, or the original string
 * @internal Exported for testing
 */
export function parseDataBody(
  data: string
): Record<string, unknown> | unknown[] | string {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    return JSON.parse(data) as Record<string, unknown> | unknown[];
  } catch {
    return data;
  }
}

/**
 * Parse a URL-encoded string into a query parameter map.
 * Duplicate keys are collected into arrays.
 */
function parseUrlEncodedParams(
  data: string
): Record<string, string | string[]> {
  const params: Record<string, string | string[]> = {};
  for (const [key, value] of new URLSearchParams(data)) {
    const existing = params[key];
    if (existing !== undefined) {
      params[key] = Array.isArray(existing)
        ? [...existing, value]
        : [existing, value];
    } else {
      params[key] = value;
    }
  }
  return params;
}

/**
 * Convert `--data` content to query parameters for bodyless HTTP methods
 * (GET, HEAD, OPTIONS).
 *
 * Handles two formats:
 * - URL-encoded strings: `"stat=received&resolution=1d"` → `{ stat: "received", resolution: "1d" }`
 * - JSON objects: `{ "stat": "received" }` → `{ stat: "received" }`
 *
 * Duplicate keys in URL-encoded strings are collected into arrays.
 *
 * @param data - Parsed output from {@link parseDataBody}
 * @returns Query parameter map suitable for `rawApiRequest`'s `params` option
 * @throws {ValidationError} When data is a JSON array or primitive (cannot be query params)
 * @internal Exported for testing
 */
export function dataToQueryParams(
  data: Record<string, unknown> | unknown[] | string
): Record<string, string | string[]> {
  if (typeof data === "string") {
    return parseUrlEncodedParams(data);
  }

  // JSON arrays and primitives (null, boolean, number) can't be query params.
  // parseDataBody uses `as` to narrow JSON.parse output, but primitives slip through.
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new ValidationError(
      "Cannot use --data with a JSON primitive or array for GET requests. " +
        "Only JSON objects and URL-encoded strings can be converted to query parameters. " +
        "Use --method POST to send this data as a request body.",
      "data"
    );
  }

  // JSON object: stringify non-string values
  const params: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(data)) {
    params[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return params;
}

/**
 * Try to parse a single field as a bare JSON **object or array** body.
 *
 * The `startsWith` guard is intentional — not just an optimisation.  It
 * restricts detection to objects (`{`) and arrays (`[`), excluding JSON
 * primitives like `42`, `true`, `"string"`.  Without this guard those
 * primitives would be extracted as the body, and downstream code (e.g. the
 * `k in body` key-conflict check) would throw a `TypeError` because the `in`
 * operator requires an object on the right-hand side.
 *
 * @internal
 */
function tryParseJsonField(
  field: string
): Record<string, unknown> | unknown[] | undefined {
  if (field.includes("=")) {
    return;
  }
  if (!(field.startsWith("{") || field.startsWith("["))) {
    return;
  }

  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    return JSON.parse(field) as Record<string, unknown> | unknown[];
  } catch {
    return;
  }
}

/**
 * Scan a field list for bare JSON **object or array** values (no `=`) and
 * extract the first one as the intended request body.  This handles the
 * common mistake of passing `-f '{"status":"ignored"}'` instead of
 * `-d '{"status":"ignored"}'`.
 *
 * Detection is conservative: the field must have no `=`, start with `{` or
 * `[`, and parse as valid JSON.  Only one JSON body is allowed — multiple
 * JSON fields are ambiguous and produce a {@link ValidationError}.
 *
 * @returns An object with the extracted `body` (if any) and the `remaining`
 *   fields that are normal key=value entries, or `undefined` if the input
 *   was empty/undefined.
 * @internal Exported for testing
 */
export function extractJsonBody(fields: string[] | undefined): {
  body?: Record<string, unknown> | unknown[];
  remaining?: string[];
} {
  if (!fields || fields.length === 0) {
    return {};
  }

  let jsonBody: Record<string, unknown> | unknown[] | undefined;
  const remaining: string[] = [];

  for (const field of fields) {
    const parsed = tryParseJsonField(field);

    if (parsed === undefined) {
      remaining.push(field);
      continue;
    }

    if (jsonBody !== undefined) {
      throw new ValidationError(
        "Multiple JSON bodies detected in field arguments. " +
          "Use --data/-d to pass an inline JSON body explicitly.",
        "field"
      );
    }

    jsonBody = parsed;
    const preview = field.length > 60 ? `${field.substring(0, 57)}...` : field;
    log.info(
      `'${preview}' was used as the request body. Use --data/-d to pass inline JSON next time.`
    );
  }

  return {
    body: jsonBody,
    remaining: remaining.length > 0 ? remaining : undefined,
  };
}

/**
 * Build request body from --input flag (file or stdin).
 * Tries to parse the content as JSON, otherwise returns as string.
 * @internal Exported for testing
 */
export async function buildBodyFromInput(
  inputPath: string,
  stdin: NodeJS.ReadStream & { fd: 0 }
): Promise<Record<string, unknown> | string> {
  let content: string;

  if (inputPath === "-") {
    content = await readStdin(stdin);
  } else {
    const exists = await access(inputPath).then(
      () => true,
      () => false
    );
    if (!exists) {
      throw new ValidationError(`File not found: ${inputPath}`, "input");
    }
    content = await readFile(inputPath, "utf-8");
  }

  // Try to parse as JSON for the API client
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return content;
  }
}

/**
 * Build request body from --field and --raw-field flags.
 * Processes typed fields first, then raw fields, allowing raw fields
 * to overwrite typed fields at the same path. Both field types are
 * merged into a single object, properly handling nested keys.
 *
 * @returns Merged object or undefined if no fields provided
 * @internal Exported for testing
 */
export function buildBodyFromFields(
  typedFields: string[] | undefined,
  rawFields: string[] | undefined
): Record<string, unknown> | undefined {
  const hasTypedFields = typedFields && typedFields.length > 0;
  const hasRawFields = rawFields && rawFields.length > 0;

  if (!(hasTypedFields || hasRawFields)) {
    return;
  }

  // Start with typed fields (JSON parsing enabled)
  const result = hasTypedFields ? parseFields(typedFields, false) : {};

  // Merge raw fields on top (no JSON parsing, can overwrite typed)
  if (hasRawFields) {
    for (const field of rawFields) {
      processField(result, field, true);
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

// Response Output

/**
 * Format a raw response body value for human-readable output.
 * Objects are pretty-printed as JSON, strings pass through, null/undefined → empty.
 * Binary bodies (`Uint8Array`) return empty — `renderCommandOutput` streams
 * them raw and never calls this formatter for that path.
 * @internal Exported for testing
 */
export function formatApiResponse(data: unknown): string {
  if (data === null || data === undefined) {
    return "";
  }
  // Guard: binary must never go through JSON.stringify / String().
  // renderCommandOutput short-circuits Uint8Array before calling us, but keep
  // this safe if a caller invokes the formatter directly.
  if (data instanceof Uint8Array) {
    return "";
  }
  if (typeof data === "object") {
    return JSON.stringify(data, null, 2);
  }
  return String(data);
}

/**
 * Summarize a binary error body for human output without dumping raw bytes.
 * Used when `sentry api` gets a non-2xx response with a non-textual body.
 * @internal Exported for testing
 */
export function formatBinaryErrorBody(
  status: number,
  headers: Headers,
  body: Uint8Array
): string {
  const contentType = headers.get("content-type") ?? "unknown";
  return (
    `HTTP ${status} — binary error body ` +
    `(${contentType}, ${body.byteLength} bytes)`
  );
}

/**
 * Format an empty textual error body with enough request context to diagnose
 * a routing miss. Sentry can return an empty body for unmatched API routes.
 * @internal Exported for testing
 */
export function formatEmptyErrorBody(
  status: number,
  statusText: string | undefined,
  method: string | undefined,
  endpoint: string | undefined
): string {
  const statusLabel = [status, statusText].filter(Boolean).join(" ");
  const request = method && endpoint ? ` — ${method} /api/0/${endpoint}` : "";
  return `HTTP ${statusLabel}${request}`;
}

type ApiResponseOutputOptions = {
  silent: boolean;
  isTTY: boolean | undefined;
  json?: boolean;
  method?: string;
  endpoint?: string;
};

type ApiResponseOutput = {
  status: number;
  statusText?: string;
  headers: Headers;
  body: unknown;
};

/** Throw the appropriate output error for a non-successful API response. */
function throwApiResponseError(
  response: ApiResponseOutput,
  options: ApiResponseOutputOptions
): never {
  const isBinary = response.body instanceof Uint8Array;
  const errorBody = isBinary
    ? formatBinaryErrorBody(
        response.status,
        response.headers,
        response.body as Uint8Array
      )
    : response.body;

  if (options.json) {
    throw new OutputError({
      status: response.status,
      statusText: response.statusText ?? "",
      body: errorBody,
    });
  }

  if (isBinary) {
    throw new OutputError(errorBody);
  }
  if (
    response.body === null ||
    response.body === undefined ||
    (typeof response.body === "string" && response.body.trim() === "")
  ) {
    throw new OutputError(
      formatEmptyErrorBody(
        response.status,
        response.statusText,
        options.method,
        options.endpoint
      )
    );
  }
  throw new OutputError(response.body);
}

/** Add HTTP metadata to textual responses in JSON output mode. */
function formatApiResponseOutput(
  response: ApiResponseOutput,
  output: unknown,
  json: boolean
): unknown {
  if (!json || output instanceof Uint8Array) {
    return output;
  }
  return {
    status: response.status,
    statusText: response.statusText,
    body: output,
  };
}

/** Preserve API body field filtering inside the response envelope. */
function formatApiResponseJson(data: unknown, fields?: string[]): unknown {
  if (
    data === null ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    !("status" in data) ||
    !("body" in data)
  ) {
    return fields && fields.length > 0 ? filterFields(data, fields) : data;
  }

  const response = data as ApiResponseOutput;
  return {
    ...response,
    body:
      fields && fields.length > 0
        ? filterFields(response.body, fields)
        : response.body,
  };
}

/**
 * Resolve the full URL that rawApiRequest would use for a request.
 *
 * Mirrors the URL construction in rawApiRequest:
 * `${baseUrl}/api/0/${endpoint}?${queryString}`
 * @internal Exported for testing
 */
export function resolveRequestUrl(
  endpoint: string,
  params?: Record<string, string | string[]>,
  baseUrl?: string
): string {
  // Use the same SDK config selection as rawApiRequest to ensure
  // trailing slashes are stripped and the URL matches what would be sent.
  const { baseUrl: normalizedBaseUrl } = baseUrl
    ? getSdkConfig(baseUrl)
    : getDefaultSdkConfig();
  const normalizedEndpoint = endpoint.startsWith("/")
    ? endpoint.slice(1)
    : endpoint;
  const endpointWithParams = appendSearchParams(normalizedEndpoint, params);
  return `${normalizedBaseUrl}/api/0/${endpointWithParams}`;
}

/**
 * Resolve effective request headers, mirroring rawApiRequest logic.
 *
 * Auto-adds Content-Type: application/json for non-string object bodies
 * when no Content-Type was explicitly provided.
 *
 * @internal Exported for testing
 */
export function resolveEffectiveHeaders(
  customHeaders: Record<string, string> | undefined,
  body: unknown
): Record<string, string> {
  // Mirror rawApiRequest exactly: auto-add Content-Type for any non-string,
  // non-undefined body when no Content-Type was explicitly provided.
  const isStringBody = typeof body === "string";
  const headers = { ...(customHeaders ?? {}) };
  const hasContentType = Object.keys(headers).some(
    (k) => k.toLowerCase() === "content-type"
  );
  if (!(isStringBody || hasContentType) && body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

/**
 * Build body and params from field flags, auto-detecting bare JSON bodies.
 *
 * Runs colon-to-equals normalization, extracts any JSON body passed as a
 * field value (with a logged hint about `--data`), and routes the remaining
 * fields to body or query params based on the HTTP method.
 *
 * @internal Exported for testing
 */
export function buildFromFields(
  method: HttpMethod,
  flags: Pick<ApiFlags, "field" | "raw-field">
): {
  body?: Record<string, unknown> | unknown[];
  params?: Record<string, string | string[]>;
} {
  const field = normalizeFields(flags.field);
  let rawField = normalizeFields(flags["raw-field"]);

  // Auto-detect bare JSON passed as a field value (common mistake).
  // GET requests don't have a body — skip detection so JSON-shaped values
  // fall through to query-param routing (which will throw a clear error).
  let body: Record<string, unknown> | unknown[] | undefined;
  if (method !== "GET") {
    const extracted = extractJsonBody(rawField);
    body = extracted.body;
    rawField = extracted.remaining;
  }

  // Route remaining fields to body (merge) or params based on HTTP method
  const options = prepareRequestOptions(method, field, rawField);
  if (options.body) {
    if (Array.isArray(body)) {
      // Can't meaningfully merge key=value fields into a JSON array body.
      throw new ValidationError(
        "Cannot combine a JSON array body with field flags (-F/-f). " +
          "Use --data/-d to pass the array as the full body without extra fields.",
        "field"
      );
    }
    if (body) {
      // Detect top-level key conflicts before merging — a shallow spread would
      // silently drop nested fields from the JSON body (e.g. statusDetails.ignoreCount
      // overwritten by statusDetails[minCount]=5).
      const conflicts = Object.keys(options.body).filter(
        (k) => k in (body as Record<string, unknown>)
      );
      if (conflicts.length > 0) {
        throw new ValidationError(
          `Field flag(s) conflict with detected JSON body at key(s): ${conflicts.join(", ")}. ` +
            "Use --data/-d to pass the full JSON body, or use only field flags (-F/-f).",
          "field"
        );
      }
    }
    // Merge field-built key=value entries into the auto-detected JSON object body
    body =
      body && typeof body === "object"
        ? { ...(body as Record<string, unknown>), ...options.body }
        : options.body;
  }

  return { body, params: options.params };
}

/**
 * Resolve the request body and query params from the user-provided flags.
 *
 * Priority order: `--data` > `--input` > field flags (`-F`/`-f`).
 * Mutually-exclusive combinations throw {@link ValidationError}.
 *
 * @returns body and params ready for the API request
 * @internal Exported for testing
 */
export async function resolveBody(
  flags: Pick<ApiFlags, "method" | "data" | "input" | "field" | "raw-field">,
  stdin: NodeJS.ReadStream & { fd: 0 }
): Promise<{
  body?: Record<string, unknown> | unknown[] | string;
  params?: Record<string, string | string[]>;
}> {
  if (flags.data !== undefined && flags.input !== undefined) {
    throw new ValidationError(
      "Cannot use --data and --input together. " +
        "Use --data/-d for inline JSON, or --input for file/stdin.",
      "data"
    );
  }

  if (
    flags.data !== undefined &&
    (flags.field?.length || flags["raw-field"]?.length)
  ) {
    throw new ValidationError(
      "Cannot use --data with --field or --raw-field. " +
        "Use --data/-d for a full JSON body, or -F/-f for individual fields.",
      "data"
    );
  }

  if (flags.data !== undefined) {
    const parsed = parseDataBody(flags.data);

    // GET/HEAD/OPTIONS cannot have a body — convert data to query params
    if (flags.method === "GET") {
      return { params: dataToQueryParams(parsed) };
    }

    return { body: parsed };
  }

  if (flags.input !== undefined) {
    return { body: await buildBodyFromInput(flags.input, stdin) };
  }

  return buildFromFields(flags.method, flags);
}

// Command Definition

/**
 * Record API error attributes on the active telemetry span.
 *
 * Since `OutputError` is excluded from `Sentry.captureException` (it signals
 * an intentional non-zero exit, not a CLI bug), these span attributes are the
 * only telemetry signal for `sentry api` HTTP errors. They're queryable in
 * Discover via `api_error.status`, matching the pattern used by
 * `recordApiErrorOnSpan` for `ApiError`-based errors in other commands.
 */
function recordApiErrorAttributes(
  status: number,
  endpoint: string,
  method: string
): void {
  const span = Sentry.getActiveSpan();
  if (span) {
    span.setAttribute("api_error.status", status);
    span.setAttribute("api_error.endpoint", endpoint);
    span.setAttribute("api_error.method", method);
  }
}

/** Log outgoing request details in `> ` curl-verbose style. */
function logRequest(
  method: string,
  endpoint: string,
  headers: Record<string, string> | undefined
): void {
  log.debug(`> ${method} /api/0/${endpoint}`);
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      log.debug(`> ${key}: ${value}`);
    }
  }
  log.debug(">");
}

/** Log incoming response details in `< ` curl-verbose style. */
function logResponse(response: {
  status: number;
  statusText?: string;
  headers: Headers;
}): void {
  log.debug(
    `< HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`
  );
  response.headers.forEach((value, key) => {
    log.debug(`< ${key}: ${value}`);
  });
  log.debug("<");
}

/**
 * Decide what `sentry api` should emit for a completed response.
 *
 * - silent: no body (OutputError(null) on error for exit code only)
 * - binary error: short status/content-type summary (never dump bytes)
 * - binary success: raw Uint8Array (the func decides TTY rendering/warning)
 * - text: body as-is for the formatter path
 * - JSON: body wrapped with HTTP status metadata by the command
 *
 * Extracted from the command func to keep cognitive complexity under the lint threshold.
 *
 * @returns data to yield via CommandOutput, or `undefined` when silent/no body
 * @throws {OutputError} on HTTP error statuses
 * @internal Exported for testing
 */
/** Every status outside the 2xx range is an API error. */
export function isApiErrorStatus(status: number): boolean {
  return status < 200 || status >= 300;
}

export function resolveApiResponseOutput(
  response: ApiResponseOutput,
  options: ApiResponseOutputOptions
): unknown {
  const isError = isApiErrorStatus(response.status);

  if (options.silent) {
    if (isError) {
      throw new OutputError(null);
    }
    return;
  }

  if (isError) {
    throwApiResponseError(response, options);
  }

  // Binary success: return raw bytes. The command func decides whether to
  // render images inline (sixel) or warn about the raw-byte dump for a TTY.
  return response.body;
}

/**
 * For a binary response headed to an interactive TTY, either render it inline
 * as an image (when it's a supported format and the terminal advertises a
 * graphics protocol) or warn that raw bytes are being dumped. Newer terminals
 * that speak the kitty protocol are preferred; sixel is the fallback.
 *
 * @param body - The raw response bytes.
 * @param headers - Response headers (Content-Type is used as a decode hint).
 * @param allowGraphics - Whether inline image rendering is permitted. Pass
 *   `false` in `--json` mode: the raw bytes still stream out unchanged, but
 *   injecting a graphics escape sequence would corrupt machine-readable output.
 *   The raw-dump warning still fires so the user knows their terminal is about
 *   to be flooded.
 * @returns A graphics escape string to write instead of the raw bytes, or
 *   `undefined` to fall through to the raw-byte behavior.
 * @internal Exported for testing
 */
export function resolveBinaryTtyOutput(
  body: Uint8Array,
  headers: Headers,
  allowGraphics = true
): string | undefined {
  if (allowGraphics) {
    // Cap the rendered width to the terminal's pixel budget so a wide image
    // doesn't overflow the columns and garble the session. Falls back to the
    // encoder's default when the terminal didn't report a cell width.
    const maxWidth = terminalPixelWidth();
    const contentType = headers.get("content-type");
    if (canRenderKitty()) {
      const kitty = imageBytesToKitty(body, contentType, maxWidth);
      if (kitty) {
        return kitty;
      }
    }
    if (canRenderSixel()) {
      const sixel = imageBytesToSixel(body, contentType, maxWidth);
      if (sixel) {
        return sixel;
      }
    }
  }

  log.warn(
    "Binary response written to a TTY — redirect stdout to a file " +
      "(e.g. `> file.bin`) to capture raw bytes cleanly."
  );
  return;
}

export const apiCommand = buildCommand({
  output: { human: formatApiResponse, jsonTransform: formatApiResponseJson },
  docs: {
    brief: "Make an authenticated API request",
    fullDescription:
      "Make a raw API request to the Sentry API. Similar to 'gh api' for GitHub. " +
      "The endpoint is relative to /api/0/ (do not include the prefix). " +
      "Absolute HTTP(S) Sentry URLs are also accepted; their origin is " +
      "validated against your authenticated host. " +
      "Authentication is handled automatically using your stored credentials.\n\n" +
      "Body options:\n" +
      '  --data/-d \'{"key":"value"}\'   Inline JSON body (like curl -d)\n' +
      '  --input/-i file.json          Read body from file (or "-" for stdin)\n\n' +
      "Field syntax (--field/-F):\n" +
      "  key=value          Simple field (values parsed as JSON if valid)\n" +
      "  key[sub]=value     Nested object: {key: {sub: value}}\n" +
      "  key[]=value        Array append: {key: [value]}\n" +
      "  key[]              Empty array: {key: []}\n\n" +
      "Use --raw-field/-f to send values as strings without JSON parsing.\n\n" +
      "Examples:\n" +
      "  sentry api organizations/\n" +
      "  sentry api issues/123/ -X PUT -F status=resolved\n" +
      '  sentry api issues/123/ -X PUT -d \'{"status":"resolved"}\'\n' +
      "  sentry api projects/my-org/my-project/ -F options[sampleRate]=0.5\n" +
      "  sentry api teams/my-org/my-team/members/ -F user[email]=user@example.com",
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "API endpoint relative to /api/0/, or an absolute HTTP(S) URL",
          parse: String,
          placeholder: "endpoint",
        },
      ],
    },
    flags: {
      method: {
        kind: "parsed",
        parse: parseMethod,
        brief: "The HTTP method for the request",
        default: "GET" as const,
        placeholder: "method",
      },
      data: {
        kind: "parsed",
        parse: String,
        brief: "Inline JSON body for the request (like curl -d)",
        optional: true,
        placeholder: "json",
      },
      field: {
        kind: "parsed",
        parse: String,
        brief: "Add a typed parameter (key=value, key[sub]=value, key[]=value)",
        variadic: true,
        optional: true,
      },
      "raw-field": {
        kind: "parsed",
        parse: String,
        brief: "Add a string parameter without JSON parsing",
        variadic: true,
        optional: true,
      },
      header: {
        kind: "parsed",
        parse: String,
        brief: "Add a HTTP request header in key:value format",
        variadic: true,
        optional: true,
      },
      input: {
        kind: "parsed",
        parse: String,
        brief:
          'The file to use as body for the HTTP request (use "-" to read from standard input)',
        optional: true,
        placeholder: "file",
      },
      silent: {
        kind: "boolean",
        brief: "Do not print the response body",
        default: false,
      },
      verbose: {
        kind: "boolean",
        brief: "Include full HTTP request and response in the output",
        default: false,
      },
      "dry-run": {
        kind: "boolean",
        brief: "Show the resolved request without sending it",
        default: false,
      },
    },
    aliases: {
      X: "method",
      d: "data",
      F: "field",
      f: "raw-field",
      H: "header",
      n: "dry-run",
    },
  },
  async *func(this: SentryContext, flags: ApiFlags, endpoint: string) {
    const { stdin } = this;

    const { normalizedEndpoint, requestBaseUrl, strippedApiPrefix } =
      resolveApiTarget(endpoint);
    tagOrgFromApiPath(normalizedEndpoint);
    if (strippedApiPrefix) {
      // Silent auto-fix — not a warning. Users commonly copy/paste URLs
      // that include the /api/0/ prefix; we strip it transparently and
      // only surface the detail at debug level for troubleshooting
      // (getsentry/cli#785 item #11).
      log.debug(
        "Stripped /api/0/ prefix from endpoint (auto-added by the API client)"
      );
    }
    const { body, params } = await resolveBody(flags, stdin);

    const headers =
      flags.header && flags.header.length > 0
        ? parseHeaders(flags.header)
        : undefined;

    // Dry-run mode: preview the request that would be sent
    if (flags["dry-run"]) {
      yield new CommandOutput({
        method: flags.method,
        url: resolveRequestUrl(normalizedEndpoint, params, requestBaseUrl),
        headers: resolveEffectiveHeaders(headers, body),
        body: body ?? null,
      });
      return;
    }

    const verbose = flags.verbose && !flags.silent;

    if (verbose) {
      logRequest(flags.method, normalizedEndpoint, headers);
    }

    // The shared authenticated fetch validates requestBaseUrl against the
    // token host and registered regional origins before adding credentials.
    const response = await rawApiRequest(normalizedEndpoint, {
      method: flags.method,
      body,
      params,
      headers,
      baseUrl: requestBaseUrl,
    });

    const isError = isApiErrorStatus(response.status);

    if (verbose) {
      logResponse(response);
    }

    // Record API error attributes on the active span for Discover queryability.
    // OutputError is excluded from Sentry.captureException (it's an intentional
    // non-zero exit, not a bug), so span attributes are the only telemetry signal.
    if (isError) {
      recordApiErrorAttributes(
        response.status,
        normalizedEndpoint,
        flags.method
      );
    }

    const output = resolveApiResponseOutput(response, {
      silent: flags.silent,
      isTTY: this.stdout.isTTY,
      json: flags.json,
      method: flags.method,
      endpoint: normalizedEndpoint,
    });
    if (output === undefined) {
      return;
    }

    // Binary body headed to an interactive TTY. Render supported images inline
    // as sixel when the terminal is capable, otherwise warn about the raw dump.
    // In --json mode we skip sixel (it would corrupt machine-readable output)
    // but still warn — renderCommandOutput dumps the raw bytes either way.
    // Redirected/piped stdout skips this entirely (raw bytes flow untouched).
    if (output instanceof Uint8Array && this.stdout.isTTY) {
      const sixel = resolveBinaryTtyOutput(
        output,
        response.headers,
        !flags.json
      );
      if (sixel !== undefined) {
        return yield new CommandOutput(sixel);
      }
    }

    // Binary Uint8Array bodies are written raw by renderCommandOutput (no
    // formatter, no trailing newline). Textual JSON responses expose the HTTP
    // metadata so callers can distinguish an empty success from an error.
    return yield new CommandOutput(
      formatApiResponseOutput(response, output, flags.json)
    );
  },
});
