/**
 * Turns raw replay recording events into a timeline of user-visible activity.
 *
 * Recording segments mix rrweb DOM events with Sentry custom events. The
 * Sentry SDKs emit custom events as `{ type: 5, data: { tag, payload } }`,
 * where `tag` is `breadcrumb` (payload is a breadcrumb with a `category`),
 * `performanceSpan` (payload is a span with an `op`), or `options`. See
 * `packages/replay-internal/src/types/replayFrame.ts` in sentry-javascript and
 * `static/app/utils/replays/replayReader.tsx` in getsentry/sentry, whose
 * deduplication rules this mirrors.
 */

export const REPLAY_TIMELINE_CATEGORIES = [
  "navigation",
  "click",
  "input",
  "console",
  "network",
  "other",
] as const;

export type ReplayTimelineCategory =
  (typeof REPLAY_TIMELINE_CATEGORIES)[number];

export interface ReplayTimelineEvent {
  timestampMs: number;
  category: ReplayTimelineCategory;
  /** Short kind such as `click`, `dead click`, `console.error`, or `request`. */
  label: string;
  /** What the event acted on: a selector, URL, or message. */
  target: string | null;
  details: ReplayTimelineDetail[];
  /**
   * Shown when no categories are requested. Low-signal events, such as
   * successful requests and console logs below warning level, are only
   * shown when their category is requested.
   */
  notable: boolean;
  /** Present on dead, rage, and slow clicks and on failed requests. */
  problem?: "dead click" | "rage click" | "slow click" | "failed request";
  /** Identifies the clicked node, for deduplication. */
  nodeId?: number;
  /** Set on `navigation` breadcrumbs, which can duplicate navigation spans. */
  fromBreadcrumb?: boolean;
}

export interface ReplayTimelineDetail {
  label: string;
  value: string;
}

const NAVIGATION_SPAN_LABELS: Record<string, string> = {
  "navigation.navigate": "page load",
  "navigation.reload": "reload",
  "navigation.back_forward": "back/forward",
  "navigation.push": "navigation",
};

const NETWORK_SPAN_OPS = new Set([
  "resource.fetch",
  "resource.xhr",
  "resource.http",
]);

// Breadcrumb categories that duplicate other events or describe the SDK
// rather than the user's session.
const IGNORED_BREADCRUMB_CATEGORIES = new Set([
  "ui.focus",
  "ui.blur",
  "fetch",
  "xhr",
  "http",
  "sentry.event",
  "sentry.transaction",
]);

// If a `navigation` breadcrumb and a `navigation.*` span are this close, they
// describe the same navigation. Matches DUPLICATE_NAV_THRESHOLD_MS in Sentry.
const DUPLICATE_NAVIGATION_THRESHOLD_MS = 2;

const MAX_TEXT_LENGTH = 200;
const DEAD_CLICK_TAGS = new Set(["a", "button", "input"]);
const RAGE_CLICK_COUNT = 5;

type UnknownRecord = Record<string, unknown>;

/**
 * Collects timeline events from one recording segment at a time, so callers
 * can discard each raw segment as soon as it is read.
 */
export class ReplayTimelineBuilder {
  private readonly events: ReplayTimelineEvent[] = [];

  addSegment(rawEvents: unknown[]): void {
    for (const rawEvent of rawEvents) {
      const event = parseRecordingEvent(rawEvent);
      if (event) {
        this.events.push(event);
      }
    }
  }

  /** Returns events sorted by time, with duplicate clicks and navigations removed. */
  build(): ReplayTimelineEvent[] {
    const sorted = [...this.events].sort(
      (a, b) => a.timestampMs - b.timestampMs,
    );
    return removeDuplicateNavigations(removeDuplicateClicks(sorted));
  }
}

function parseRecordingEvent(rawEvent: unknown): ReplayTimelineEvent | null {
  const event = asRecord(rawEvent);
  const data = asRecord(event?.data);
  const payload = asRecord(data?.payload);
  if (!event || !data || !payload) {
    return null;
  }

  const eventTimestampMs = asNumber(event.timestamp);
  if (data.tag === "breadcrumb") {
    return parseBreadcrumb(
      payload,
      secondsToMs(asNumber(payload.timestamp)) ?? eventTimestampMs,
    );
  }
  if (data.tag === "performanceSpan") {
    return parseSpan(
      payload,
      secondsToMs(asNumber(payload.startTimestamp)) ?? eventTimestampMs,
    );
  }
  return null;
}

function parseBreadcrumb(
  payload: UnknownRecord,
  timestampMs: number | null,
): ReplayTimelineEvent | null {
  const category = asString(payload.category);
  if (timestampMs === null || !category) {
    return null;
  }
  if (
    IGNORED_BREADCRUMB_CATEGORIES.has(category) ||
    (category.startsWith("replay.") &&
      category !== "replay.mutations" &&
      category !== "replay.hydrate-error")
  ) {
    return null;
  }

  const data = asRecord(payload.data);
  const message = truncate(asString(payload.message));
  const base = { timestampMs, details: [] as ReplayTimelineDetail[] };

  switch (category) {
    case "ui.click":
    case "ui.tap":
      return {
        ...base,
        category: "click",
        label: category === "ui.tap" ? "tap" : "click",
        target: message,
        details: nodeTextDetails(data),
        notable: true,
        nodeId: asNumber(data?.nodeId) ?? undefined,
      };
    case "ui.slowClickDetected":
      return parseSlowClick(base, message, data);
    case "ui.multiClick": {
      const clickCount = asNumber(data?.clickCount) ?? 0;
      if (clickCount < RAGE_CLICK_COUNT) {
        return null;
      }
      return {
        ...base,
        category: "click",
        label: "rage click",
        target: message,
        details: [
          ...nodeTextDetails(data),
          { label: "clicks", value: String(clickCount) },
        ],
        notable: true,
        problem: "rage click",
      };
    }
    case "ui.input":
      return {
        ...base,
        category: "input",
        label: "input",
        target: message,
        notable: true,
      };
    case "ui.keyDown": {
      const key = formatKey(data);
      if (!key) {
        return null;
      }
      return {
        ...base,
        category: "input",
        label: "key",
        target: message,
        details: [{ label: "key", value: key }],
        notable: true,
      };
    }
    case "navigation": {
      const to = truncate(asString(data?.to));
      if (!to) {
        return null;
      }
      return {
        ...base,
        category: "navigation",
        label: "navigation",
        target: to,
        notable: true,
        fromBreadcrumb: true,
      };
    }
    case "console": {
      if (data?.logger === "replay" || message === null) {
        return null;
      }
      const level = asString(payload.level) ?? "log";
      return {
        ...base,
        category: "console",
        label: `console.${level}`,
        target: message,
        notable: level === "error" || level === "warning" || level === "fatal",
      };
    }
    case "sentry.feedback":
      return {
        ...base,
        category: "other",
        label: "user feedback",
        target: asString(data?.feedbackId),
        notable: true,
      };
    case "replay.hydrate-error":
      return {
        ...base,
        category: "other",
        label: "hydration error",
        target: truncate(asString(data?.url)),
        notable: true,
      };
    case "replay.mutations": {
      const count = asNumber(data?.count);
      return {
        ...base,
        category: "other",
        label: "large DOM mutation",
        target: null,
        details:
          count !== null ? [{ label: "mutations", value: String(count) }] : [],
        notable: true,
      };
    }
    default:
      // Breadcrumbs the application added itself, such as `auth` or
      // `dialog.closed`, often describe exactly what the user did.
      if (category.startsWith("ui.")) {
        return null;
      }
      return {
        ...base,
        category: "other",
        label: category,
        target: message,
        notable: true,
      };
  }
}

function parseSlowClick(
  base: { timestampMs: number; details: ReplayTimelineDetail[] },
  message: string | null,
  data: UnknownRecord | null,
): ReplayTimelineEvent {
  const node = asRecord(data?.node);
  const tagName = asString(node?.tagName)?.toLowerCase() ?? "";
  const endReason = asString(data?.endReason);
  const timeAfterClickMs = asNumber(data?.timeAfterClickMs);
  const clickCount = asNumber(data?.clickCount);
  // Same rule as isDeadClick in Sentry: an interactive element that produced
  // no DOM change before the SDK gave up waiting.
  const isDead = DEAD_CLICK_TAGS.has(tagName) && endReason === "timeout";
  const isRage = isDead && (clickCount ?? 0) >= RAGE_CLICK_COUNT;

  const details = nodeTextDetails(data);
  if (timeAfterClickMs !== null) {
    details.push({
      label: isDead ? "no response after" : "response after",
      value: formatDurationMs(timeAfterClickMs),
    });
  }
  if (!isDead && endReason) {
    details.push({ label: "ended by", value: endReason });
  }
  if (clickCount !== null && clickCount > 1) {
    details.push({ label: "clicks", value: String(clickCount) });
  }

  const label = isRage ? "rage click" : isDead ? "dead click" : "slow click";
  return {
    ...base,
    category: "click",
    label,
    target: message,
    details,
    notable: true,
    problem: label,
    nodeId: asNumber(data?.nodeId) ?? undefined,
  };
}

function parseSpan(
  payload: UnknownRecord,
  timestampMs: number | null,
): ReplayTimelineEvent | null {
  const op = asString(payload.op);
  if (timestampMs === null || !op) {
    return null;
  }

  const description = truncate(asString(payload.description));
  const navigationLabel = NAVIGATION_SPAN_LABELS[op];
  if (navigationLabel) {
    return {
      timestampMs,
      category: "navigation",
      label: navigationLabel,
      target: description,
      details: [],
      notable: true,
    };
  }

  if (!NETWORK_SPAN_OPS.has(op)) {
    return null;
  }

  const data = asRecord(payload.data);
  const method = asString(data?.method);
  const statusCode = asNumber(data?.statusCode);
  const endTimestampMs = secondsToMs(asNumber(payload.endTimestamp));
  const details: ReplayTimelineDetail[] = [];
  if (statusCode !== null) {
    details.push({ label: "status", value: String(statusCode) });
  }
  if (endTimestampMs !== null && endTimestampMs >= timestampMs) {
    details.push({
      label: "duration",
      value: formatDurationMs(endTimestampMs - timestampMs),
    });
  }

  // Status 0 means the request never completed, such as a network error or a
  // blocked CORS request.
  const failed = statusCode !== null && (statusCode === 0 || statusCode >= 400);
  return {
    timestampMs,
    category: "network",
    label: "request",
    target: [method, description].filter(Boolean).join(" ") || null,
    details,
    notable: failed,
    ...(failed ? { problem: "failed request" as const } : {}),
  };
}

/**
 * The SDK records a click as both `ui.click` and, when it gets no response,
 * `ui.slowClickDetected` for the same node and time. Keep the latter.
 */
function removeDuplicateClicks(
  events: ReplayTimelineEvent[],
): ReplayTimelineEvent[] {
  const slowClicks = new Set(
    events
      .filter((event) => event.problem && event.nodeId !== undefined)
      .map((event) => `${event.nodeId}:${event.timestampMs}`),
  );
  return events.filter(
    (event) =>
      event.label !== "click" ||
      event.nodeId === undefined ||
      !slowClicks.has(`${event.nodeId}:${event.timestampMs}`),
  );
}

/** Prefer `navigation.*` spans over matching `navigation` breadcrumbs. */
function removeDuplicateNavigations(
  events: ReplayTimelineEvent[],
): ReplayTimelineEvent[] {
  const spanTimestamps = events
    .filter((event) => event.category === "navigation" && !event.fromBreadcrumb)
    .map((event) => event.timestampMs);

  return events.filter(
    (event) =>
      !event.fromBreadcrumb ||
      !spanTimestamps.some(
        (timestampMs) =>
          Math.abs(timestampMs - event.timestampMs) <=
          DUPLICATE_NAVIGATION_THRESHOLD_MS,
      ),
  );
}

function nodeTextDetails(data: UnknownRecord | null): ReplayTimelineDetail[] {
  const node = asRecord(data?.node);
  const textContent = truncate(asString(node?.textContent));
  return textContent ? [{ label: "text", value: textContent }] : [];
}

function formatKey(data: UnknownRecord | null): string | null {
  const key = data?.key === " " ? "Space" : asString(data?.key);
  if (!key) {
    return null;
  }
  const modifiers = [
    { pressed: data?.ctrlKey, key: "Control", label: "Ctrl" },
    { pressed: data?.metaKey, key: "Meta", label: "Meta" },
    { pressed: data?.altKey, key: "Alt", label: "Alt" },
    { pressed: data?.shiftKey, key: "Shift", label: "Shift" },
  ]
    // A modifier pressed on its own reports itself as both key and modifier.
    .filter((modifier) => modifier.pressed === true && modifier.key !== key)
    .map((modifier) => modifier.label);
  return [...modifiers, key].join("+");
}

function formatDurationMs(durationMs: number): string {
  if (durationMs < 1000) {
    return `${Math.round(durationMs)}ms`;
  }
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function secondsToMs(value: number | null): number | null {
  if (value === null) {
    return null;
  }
  // Breadcrumb and span timestamps are seconds; rrweb event timestamps are
  // milliseconds. Some SDKs send milliseconds in both places.
  return value > 1e12 ? value : value * 1000;
}

function truncate(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  return value.length > MAX_TEXT_LENGTH
    ? `${value.slice(0, MAX_TEXT_LENGTH)}…`
    : value;
}

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
