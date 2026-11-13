import { inlineCode } from "@sentry/toolkit-core/markdown";
import type { Event, SourceMapDebug } from "../api-client/types";
import {
  type SideQuest,
  type SideQuestCandidate,
  type SideQuestDetector,
  MAX_DETAILS,
  buildSideQuests,
} from "./side-quests";
import { diagnoseSourceMaps, formatFileList } from "./source-map-diagnosis";
import type { ToolSession } from "./tool-helpers/tool-call-formatting";

/**
 * The side quests for an issue's event: setup problems, such as missing
 * source maps, that would make future issues easier to debug. Detectors read
 * the event and the checks already fetched for it, such as Sentry's source
 * map debug result.
 *
 * To add one, write a detector that returns a quest or null and add it to
 * `DETECTORS`.
 */
export interface IssueSideQuestInput {
  event: Event;
  /** Optional; a detector works without it. */
  sourceMapDebug?: SourceMapDebug;
}

const MAX_FILES = 3;

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

const NOT_APPLIED = "Source maps weren't applied";
const MINIFIED = "so frames may be minified";

/**
 * Warns when Sentry could not apply source maps. With Sentry's source map
 * check, the tip names each file's cause and fix; when causes differ by file,
 * `details` lists them. Otherwise the error types' problems and fixes apply.
 */
function detectJsSourceMapFailure({
  event,
  sourceMapDebug,
}: IssueSideQuestInput): SideQuestCandidate | null {
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
  // what the error types imply, for files the check does not explain
  const fallback = `${matched.map(([, detail]) => detail.problem).join("; ")}. ${[...new Set(matched.map(([, detail]) => detail.fix))].join(" ")}`;
  const quest = (tip: string, details?: string[]): SideQuestCandidate => ({
    rank: 0,
    id: "js_source_maps",
    tip,
    docs: JS_SOURCE_MAPS_TROUBLESHOOTING_URL,
    details,
  });

  const listed = new Map([...files].slice(0, MAX_FILES));
  const diagnosis = sourceMapDebug
    ? diagnoseSourceMaps({ event, debug: sourceMapDebug, files: listed })
    : [];
  const diagnosed = new Set(diagnosis.flatMap((finding) => finding.files));
  const undiagnosed = [...listed.keys()].filter((file) => !diagnosed.has(file));
  const unlisted = files.size - listed.size;

  if (diagnosis.length === 0) {
    const where =
      files.size > 0
        ? ` to ${formatFileList([...listed.keys()], unlisted)}`
        : "";
    return quest(`${NOT_APPLIED}${where}, ${MINIFIED}: ${fallback}`);
  }
  const [only] = diagnosis;
  if (diagnosis.length === 1 && diagnosed.size === files.size) {
    return quest(`${NOT_APPLIED}, ${MINIFIED}: ${only.problem}. ${only.fix}`);
  }

  // causes differ by file, or some files have no diagnosis. The remainder
  // line takes the last slot under the details cap, so a cause past it joins
  // the remainder instead of pushing the remainder out.
  const hasRest = undiagnosed.length > 0 || unlisted > 0;
  const shown = diagnosis.slice(0, hasRest ? MAX_DETAILS - 1 : MAX_DETAILS);
  const details = shown.map(({ problem, fix }) => `${problem}. ${fix}`);
  const restFiles = [
    ...diagnosis.slice(shown.length).flatMap((finding) => finding.files),
    ...undiagnosed,
  ];
  if (hasRest) {
    const rest =
      restFiles.length > 0
        ? formatFileList(restFiles, unlisted)
        : `${unlisted} more ${unlisted === 1 ? "file" : "files"}`;
    details.push(`${rest}: ${fallback}`);
  }
  return quest(
    `${NOT_APPLIED} to ${files.size} files, ${MINIFIED}; the cause differs by file.`,
    details,
  );
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
function detectMissingUserIdentity({
  event,
}: IssueSideQuestInput): SideQuestCandidate | null {
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

  // the JavaScript identify-user pages redirect to the SDK APIs page
  const page =
    setUser?.call === JS_SET_USER
      ? "configuration/apis"
      : "enriching-events/identify-user";
  // the generic page asks which platform to show
  const docs = setUser
    ? `https://docs.sentry.io/platforms/${setUser.docs}/${page}/`
    : "https://docs.sentry.io/platform-redirect/?next=/enriching-events/identify-user/";

  const problem =
    hasValue(user?.ip_address) || hasValue(user?.ip)
      ? "The user is identified only by IP, so Users Impacted is approximate."
      : "The event has no user, so it doesn't count toward Users Impacted.";

  return {
    rank: 10,
    id: "missing_user_identity",
    tip: `${problem} Call ${call} after sign-in; an opaque ID is enough.`,
    docs,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasFrames(stacktrace: unknown): boolean {
  return (
    isRecord(stacktrace) &&
    Array.isArray(stacktrace.frames) &&
    stacktrace.frames.length > 0
  );
}

/**
 * Whether any exception, thread, or top-level stacktrace on the event has
 * frames. Native and Apple crashes keep the stack on the crashed thread, and
 * Python logging calls with `stack_info=True` or `attach_stacktrace` put it on
 * the current thread, so threads count too.
 */
function hasStackFrames(event: Event): boolean {
  return event.entries.some(({ type, data }) => {
    if (!isRecord(data)) {
      return false;
    }
    if (type === "stacktrace") {
      return hasFrames(data);
    }
    if (type !== "exception" && type !== "threads") {
      return false;
    }
    const values = Array.isArray(data.values) ? data.values : [data.value];
    return values.some(
      (value) => isRecord(value) && hasFrames(value.stacktrace),
    );
  });
}

const JS_TROUBLESHOOTING_URL =
  "https://docs.sentry.io/platforms/javascript/troubleshooting/";

/**
 * The browser's message for an error thrown by a script from another origin.
 * The browser SDK adds a placeholder `?` frame to these (`globalhandlers.ts`
 * in getsentry/sentry-javascript), so they are matched even with frames.
 */
const SCRIPT_ERROR = /^Script error\.?$/;

/**
 * Exception values the JavaScript SDK writes when the thrown or rejected value
 * is not an `Error` (`getNonErrorObjectExceptionValue` in
 * `packages/browser/src/eventbuilder.ts` and `getMessageForObject` in
 * `packages/core/src/utils/eventbuilder.ts` in getsentry/sentry-javascript;
 * `Non-Error exception captured` is the older SDKs' wording).
 */
const NON_ERROR_VALUE =
  /^(?:Non-Error (?:exception|promise rejection) captured|(?:Object|'[^']*') captured as (?:exception|promise rejection)|Event `[^`]*` (?:\(type=[^)]*\) )?captured as (?:exception|promise rejection))/;

const JS_MESSAGE_FIX = {
  capture: "Sentry.captureException(err)",
  option: "attachStacktrace: true",
};

/**
 * How to get a stack on a message event, by `event.platform`: the call that
 * reports a caught error, and the option that attaches the current stack to
 * messages. Ruby attaches the caller's stack to every message, and Java, .NET,
 * and Dart turn the option on by default, so they are left out.
 */
const MESSAGE_FIX_BY_PLATFORM: ReadonlyMap<
  string,
  { capture: string; option: string; docsUrl: string }
> = new Map([
  [
    "python",
    {
      capture: "sentry_sdk.capture_exception(e)",
      option: "attach_stacktrace=True",
      docsUrl:
        "https://docs.sentry.io/platforms/python/configuration/options/#attach_stacktrace",
    },
  ],
  [
    "javascript",
    {
      ...JS_MESSAGE_FIX,
      docsUrl:
        "https://docs.sentry.io/platforms/javascript/configuration/options/#attachStacktrace",
    },
  ],
  [
    "node",
    {
      ...JS_MESSAGE_FIX,
      docsUrl:
        "https://docs.sentry.io/platforms/javascript/guides/node/configuration/options/#attachStacktrace",
    },
  ],
  [
    "php",
    {
      capture: "\\Sentry\\captureException($e)",
      option: "'attach_stacktrace' => true",
      docsUrl:
        "https://docs.sentry.io/platforms/php/configuration/options/#attach_stacktrace",
    },
  ],
  [
    "go",
    {
      capture: "sentry.CaptureException(err)",
      option: "AttachStacktrace: true",
      docsUrl:
        "https://docs.sentry.io/platforms/go/configuration/options/#AttachStacktrace",
    },
  ],
]);

const JS_CONSOLE_FIX = `Pass the ${inlineCode("Error")} itself to ${inlineCode("console.error(...)")}, or set ${inlineCode(JS_MESSAGE_FIX.option)} in ${inlineCode("Sentry.init")}.`;

/**
 * How to log with the exception, by `event.platform`. The SDKs' logging
 * integrations set `event.logger`, which Sentry copies to the `logger` tag:
 * the Python logging integration to the logger name, the JavaScript
 * `captureConsoleIntegration` to `console`, and the PHP Monolog handler to
 * `monolog.<channel>`.
 */
const LOGGING_FIX_BY_PLATFORM: ReadonlyMap<
  string,
  { fix: string; docsUrl: string; logger?: string }
> = new Map([
  [
    "python",
    {
      fix: `Log inside the ${inlineCode("except")} block with ${inlineCode("logger.exception(...)")}, or set ${inlineCode("attach_stacktrace=True")} in ${inlineCode("sentry_sdk.init")}.`,
      docsUrl: "https://docs.sentry.io/platforms/python/integrations/logging/",
    },
  ],
  [
    "javascript",
    {
      logger: "console",
      fix: JS_CONSOLE_FIX,
      docsUrl:
        "https://docs.sentry.io/platforms/javascript/configuration/integrations/captureconsole/",
    },
  ],
  [
    "node",
    {
      logger: "console",
      fix: JS_CONSOLE_FIX,
      docsUrl:
        "https://docs.sentry.io/platforms/javascript/guides/node/configuration/integrations/captureconsole/",
    },
  ],
  [
    "php",
    {
      fix: `Pass the exception in the log context, as in ${inlineCode("$logger->error('...', ['exception' => $e])")}.`,
      docsUrl: "https://docs.sentry.io/platforms/php/integrations/monolog/",
    },
  ],
]);

function getTag(event: Event, key: string) {
  const value = event.tags?.find((tag) => tag.key === key)?.value;
  return hasValue(value) ? value : null;
}

function getEventMessages(event: Event): string[] {
  const messages: unknown[] = [event.title, event.message];
  for (const { type, data } of event.entries) {
    if (!isRecord(data)) {
      continue;
    }
    if (type === "message") {
      messages.push(data.formatted, data.message);
    }
    if (type === "exception") {
      const values = Array.isArray(data.values) ? data.values : [data.value];
      for (const value of values) {
        messages.push(isRecord(value) ? value.value : null);
      }
    }
  }
  return messages.filter(
    (message): message is string => typeof message === "string",
  );
}

function isCrossOriginScriptError(event: Event) {
  return getEventMessages(event).some((message) => SCRIPT_ERROR.test(message));
}

/**
 * Whether the event has a stack worth reading: frames other than the
 * placeholder on a cross-origin `Script error.`.
 */
export function hasReadableStack(event: Event): boolean {
  return hasStackFrames(event) && !isCrossOriginScriptError(event);
}

function missingStackTrace(tip: string, docs: string): SideQuestCandidate {
  return { rank: 5, id: "missing_stack_trace", tip, docs };
}

/**
 * Suggests how to get a stack trace on an error event that has none, when the
 * event shows the cause: a cross-origin `Script error.`, a JavaScript non-Error
 * throw or rejection, a logging call without the exception, or a captured
 * message, on a platform whose fix is known. An exception with no frames and no
 * such signal gets no concern: the output already says it has no stacktrace,
 * and the SDK attach-stacktrace options only apply to messages, so there is no
 * fix to suggest.
 *
 * Only error and default (message) events are checked, as for user identity.
 */
function detectMissingStackTrace({
  event,
}: IssueSideQuestInput): SideQuestCandidate | null {
  if (event.type !== "error" && event.type !== "default") {
    return null;
  }
  if (isCrossOriginScriptError(event)) {
    return missingStackTrace(
      `The browser hid this error's message and stack because the script came from another origin. Add ${inlineCode('crossorigin="anonymous"')} to its ${inlineCode("<script>")} tag and serve the script with an ${inlineCode("Access-Control-Allow-Origin")} header.`,
      `${JS_TROUBLESHOOTING_URL}#cors-attributes-and-headers`,
    );
  }
  if (hasStackFrames(event)) {
    return null;
  }
  if (
    getEventMessages(event).some((message) => NON_ERROR_VALUE.test(message))
  ) {
    return missingStackTrace(
      `The code threw or rejected with a value that is not an ${inlineCode("Error")}, so there was no stack to capture. Wrap the value in ${inlineCode("new Error(...)")} where it is thrown or rejected.`,
      `${JS_TROUBLESHOOTING_URL}#events-with-non-error-exception`,
    );
  }
  // an exception without frames, such as one that was never raised, has no
  // signal for a fix
  const entryTypes = new Set(event.entries.map(({ type }) => type));
  if (entryTypes.has("exception") || !entryTypes.has("message")) {
    return null;
  }

  const platform = event.platform ?? "";
  const logger = getTag(event, "logger");
  if (logger) {
    const logging = LOGGING_FIX_BY_PLATFORM.get(platform);
    if (!logging || (logging.logger && logging.logger !== logger)) {
      return null;
    }
    // the logger name is upstream data, so it is quoted with inlineCode
    return missingStackTrace(
      `This event came from the ${inlineCode(logger)} logger with no exception attached. ${logging.fix}`,
      logging.docsUrl,
    );
  }

  const message = MESSAGE_FIX_BY_PLATFORM.get(platform);
  if (!message) {
    return null;
  }
  return missingStackTrace(
    `This event was captured as a message, which has no stack trace. Report caught errors with ${inlineCode(message.capture)} instead, or set ${inlineCode(message.option)} to attach the current stack to messages.`,
    message.docsUrl,
  );
}

const DETECTORS: readonly SideQuestDetector<IssueSideQuestInput>[] = [
  detectJsSourceMapFailure,
  detectMissingStackTrace,
  detectMissingUserIdentity,
];

/** The side quests an issue's event points to, most useful first. */
export function buildIssueSideQuests(
  input: IssueSideQuestInput,
  session: ToolSession,
): SideQuest[] | undefined {
  return buildSideQuests(input, DETECTORS, session);
}
