import { inlineCode } from "@sentry/toolkit-core/markdown";
import { z } from "zod";
import type { Event, SourceMapDebug } from "../api-client/types";
import { diagnoseSourceMaps } from "./source-map-diagnosis";

/**
 * Concerns are problems with the project's Sentry setup, such as missing
 * source maps, that are optional to fix but would make future issues easier to
 * debug. Detectors read the event and the checks already fetched for it in
 * `ConcernContext`, such as Sentry's source map debug result. When the problem
 * also changes how to read this event, the concern carries a one-line `caveat`
 * that renders next to the affected data.
 *
 * To add one, write a detector that returns a `Concern` or null and add it to
 * `DETECTORS`. `buildConcerns` orders them by priority and keeps the first
 * `MAX_CONCERNS`.
 */
export const concernSchema = z.object({
  code: z
    .string()
    .describe("Stable identifier of the problem, such as js_source_maps."),
  title: z.string(),
  message: z.string().describe("What is wrong and how to fix it."),
  docsUrl: z.string(),
  errorTypes: z
    .array(z.string())
    .describe("The Sentry event processing error types behind it."),
  files: z
    .array(z.string())
    .describe("Affected files, capped; fileCount says how many there are."),
  fileCount: z.number(),
  diagnosis: z
    .array(
      z.object({
        problem: z.string(),
        fix: z.string(),
        files: z.array(z.string()),
      }),
    )
    .describe(
      "Cause and fix for the affected files, from a Sentry check of this event. Empty when no check ran.",
    ),
  caveat: z
    .string()
    .nullable()
    .describe("How the problem affects reading this event, when it does."),
});

export type Concern = z.output<typeof concernSchema>;

const MAX_CONCERNS = 3;
const MAX_FILES = 3;

interface PrioritizedConcern {
  /** Lower comes first. */
  priority: number;
  concern: Concern;
}

/** Optional checks fetched for the event; a detector works without them. */
export interface ConcernContext {
  sourceMapDebug?: SourceMapDebug;
}

type Detector = (
  event: Event,
  context: ConcernContext,
) => PrioritizedConcern | null;

const JS_SOURCE_MAPS_DOCS_URL =
  "https://docs.sentry.io/platforms/javascript/sourcemaps/";
const JS_SOURCE_MAPS_TROUBLESHOOTING_URL =
  "https://docs.sentry.io/platforms/javascript/sourcemaps/troubleshooting_js/";

const UPLOAD_FIX =
  "Upload source maps for this release from the same build that was deployed.";

/**
 * The JavaScript processing error types in getsentry/sentry
 * `src/sentry/models/eventerror.py`, with what each one means for the user.
 * Order sets which problem is listed first. Sentry's actionable-items endpoint
 * hides `js_no_source` and `js_invalid_sourcemap_location`; we keep them
 * because they are the most common reason a stacktrace stays minified.
 */
const JS_SOURCE_MAP_ERRORS: ReadonlyMap<
  string,
  { problem: string; fix: string }
> = new Map([
  [
    "js_no_source",
    {
      problem: "the source file or its source map was not found",
      fix: UPLOAD_FIX,
    },
  ],
  [
    "js_invalid_sourcemap_location",
    {
      problem: "the source map does not match the minified file",
      fix: UPLOAD_FIX,
    },
  ],
  [
    "js_invalid_source",
    {
      problem: "the source map is invalid or could not be parsed",
      fix: "Regenerate the source map and upload it again.",
    },
  ],
  [
    "js_missing_sources_content",
    {
      problem: "the source map does not include the original source",
      fix: "Include sourcesContent in the source map, or upload the original source files.",
    },
  ],
  [
    "js_scraping_disabled",
    {
      problem:
        "source fetching is disabled for the project and no source maps were uploaded",
      fix: `${UPLOAD_FIX} Or enable JavaScript source fetching in the project settings.`,
    },
  ],
  [
    "js_invalid_source_encoding",
    {
      problem: "the source file is not encoded properly",
      fix: "Serve or upload the source files as UTF-8.",
    },
  ],
  [
    "js_invalid_content",
    {
      problem: "the source file is not JavaScript",
      fix: UPLOAD_FIX,
    },
  ],
  [
    "js_no_column",
    {
      problem: "the stacktrace has no column numbers to map",
      fix: "Make sure the runtime reports column numbers in stack traces.",
    },
  ],
  [
    "js_too_many_sources",
    {
      problem: "the limit of remote source requests was reached",
      fix: UPLOAD_FIX,
    },
  ],
  // deprecated by Sentry, but older events still carry them
  [
    "js_generic_fetch_error",
    { problem: "the source file could not be fetched", fix: UPLOAD_FIX },
  ],
  [
    "js_invalid_http_code",
    {
      problem: "fetching the source file returned an HTTP error",
      fix: UPLOAD_FIX,
    },
  ],
  [
    "js_too_large",
    { problem: "the source file is too large to fetch", fix: UPLOAD_FIX },
  ],
  [
    "js_fetch_timeout",
    { problem: "fetching the source file timed out", fix: UPLOAD_FIX },
  ],
]);

function getErrorFile(data: Record<string, unknown> | null | undefined) {
  // most JS processing errors name the file in `url`; sources content and
  // location errors name it in `source`
  const file = data?.url ?? data?.source;
  return typeof file === "string" && file.length > 0 ? file : null;
}

/** Whether Sentry reported a JavaScript source map failure for the event. */
export function hasJsSourceMapErrors(event: Event): boolean {
  return (event.errors ?? []).some(({ type }) =>
    JS_SOURCE_MAP_ERRORS.has(type),
  );
}

function detectJsSourceMapFailure(
  event: Event,
  { sourceMapDebug }: ConcernContext,
): PrioritizedConcern | null {
  const errorTypes = new Set<string>();
  // each affected file with the error types reported for it
  const files = new Map<string, Set<string>>();
  for (const error of event.errors ?? []) {
    if (!JS_SOURCE_MAP_ERRORS.has(error.type)) {
      continue;
    }
    errorTypes.add(error.type);
    const file = getErrorFile(error.data);
    if (file) {
      files.set(file, (files.get(file) ?? new Set()).add(error.type));
    }
  }
  if (errorTypes.size === 0) {
    return null;
  }

  const matched = [...JS_SOURCE_MAP_ERRORS].filter(([type]) =>
    errorTypes.has(type),
  );
  const problems = matched.map(([, detail]) => detail.problem).join("; ");
  const listed = new Map([...files].slice(0, MAX_FILES));
  const listedFiles = [...listed.keys()];
  const diagnosis = sourceMapDebug
    ? diagnoseSourceMaps({ event, debug: sourceMapDebug, files: listed })
    : [];
  // a diagnosis names the exact fix for its files; the error types' fix
  // covers the rest, and events whose errors name no file
  const fix =
    countDiagnosedFiles(diagnosis) === files.size && files.size > 0
      ? ""
      : ` Fix: ${[...new Set(matched.map(([, detail]) => detail.fix))].join(" ")}`;

  return {
    priority: 0,
    concern: {
      code: "js_source_maps",
      title: "Fix JavaScript source maps",
      message: `Sentry could not apply source maps to this event: ${problems}.${fix} Troubleshooting: ${JS_SOURCE_MAPS_TROUBLESHOOTING_URL}`,
      docsUrl: JS_SOURCE_MAPS_DOCS_URL,
      errorTypes: matched.map(([type]) => type),
      files: listedFiles,
      fileCount: files.size,
      diagnosis,
      caveat:
        "Source maps were not applied to this event; frames may point to minified code. See Concerns Identified.",
    },
  };
}

function countDiagnosedFiles(diagnosis: Concern["diagnosis"]): number {
  return diagnosis.reduce((count, { files }) => count + files.length, 0);
}

const JS_SET_USER = "Sentry.setUser({ id: user.id })";

/**
 * How to identify the user, by `event.platform`: the docs platform path and the
 * SDK call. Android events report `java`, React Native `javascript`, Flutter
 * `dart`, and Unity `csharp`, so they share those entries.
 */
const SET_USER_BY_PLATFORM: ReadonlyMap<
  string,
  { docs: string; call: string }
> = new Map([
  ["javascript", { docs: "javascript", call: JS_SET_USER }],
  ["node", { docs: "javascript/guides/node", call: JS_SET_USER }],
  ["python", { docs: "python", call: 'sentry_sdk.set_user({"id": user.id})' }],
  ["ruby", { docs: "ruby", call: "Sentry.set_user(id: user.id)" }],
  ["php", { docs: "php", call: "$scope->setUser(['id' => $user->id])" }],
  ["java", { docs: "java", call: "Sentry.setUser(user)" }],
  ["go", { docs: "go", call: "scope.SetUser(sentry.User{ID: user.ID})" }],
  [
    "csharp",
    { docs: "dotnet", call: "scope.User = new SentryUser { Id = user.Id }" },
  ],
  ["cocoa", { docs: "apple", call: "SentrySDK.setUser(user)" }],
  ["dart", { docs: "dart", call: "scope.setUser(SentryUser(id: user.id))" }],
  [
    "elixir",
    { docs: "elixir", call: "Sentry.Context.set_user_context(%{id: user.id})" },
  ],
  ["native", { docs: "native", call: "sentry_set_user(user)" }],
]);

function hasValue(value: string | null | undefined) {
  return typeof value === "string" && value.length > 0;
}

/**
 * Warns when an error event has no user ID, email, or username.
 *
 * Sentry counts Users Impacted as the distinct values of the `sentry:user`
 * tag, which it sets from the first of the user's id, username, email, or IP
 * address (`EventUser.tag_value` in getsentry/sentry
 * `src/sentry/utils/eventuser.py`, set in `_get_event_user_many` in
 * `src/sentry/event_manager.py`; counted with `uniq(tags[sentry:user])` in
 * `src/sentry/api/serializers/models/group.py`). So an event with no user is
 * not counted at all, and an event with only an IP address is counted by IP.
 *
 * Only error and default (message) events are checked. Performance issues
 * (transactions), metric, cron, uptime, and other generic issues, and CSP
 * reports do not come from code that can identify a signed-in user.
 */
function detectMissingUserIdentity(event: Event): PrioritizedConcern | null {
  if (event.type !== "error" && event.type !== "default") {
    return null;
  }
  const user = event.user;
  if (hasValue(user?.id) || hasValue(user?.email) || hasValue(user?.username)) {
    return null;
  }

  const setUser = event.platform
    ? SET_USER_BY_PLATFORM.get(event.platform)
    : undefined;
  const call = setUser
    ? inlineCode(setUser.call)
    : `${inlineCode(JS_SET_USER)} or your SDK's equivalent`;
  // the generic page asks which platform to show
  const docsUrl = setUser
    ? `https://docs.sentry.io/platforms/${setUser.docs}/enriching-events/identify-user/`
    : "https://docs.sentry.io/platform-redirect/?next=/enriching-events/identify-user/";

  const problem =
    hasValue(user?.ip_address) || hasValue(user?.ip)
      ? "This event identifies the user only by IP address, so Users Impacted is approximate and you can't tell which signed-in users hit it."
      : "This event has no user, so it doesn't count toward Users Impacted.";

  return {
    priority: 10,
    concern: {
      code: "missing_user_identity",
      title: "Identify users in events",
      message: `${problem} Call ${call} after sign-in; an opaque internal ID is enough.`,
      docsUrl,
      errorTypes: [],
      files: [],
      fileCount: 0,
      diagnosis: [],
      caveat: null,
    },
  };
}

const DETECTORS: readonly Detector[] = [
  detectJsSourceMapFailure,
  detectMissingUserIdentity,
];

/** The concerns an event points to, most important first. */
export function buildConcerns(
  event: Event,
  context: ConcernContext = {},
): Concern[] {
  return DETECTORS.flatMap((detect) => {
    const result = detect(event, context);
    return result ? [result] : [];
  })
    .sort((a, b) => a.priority - b.priority)
    .slice(0, MAX_CONCERNS)
    .map((result) => result.concern);
}
