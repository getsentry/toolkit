import { formatExceptionTitle, getEventExceptions } from "./exceptions.ts";
import { isLoopbackHost } from "../../../../packages/cli/src/commands/local/loopback.ts";
export { isLoopbackHost } from "../../../../packages/cli/src/commands/local/loopback.ts";

export const SENTRY_ENVELOPE_EVENT = "application/x-sentry-envelope";
export const STREAM_STORAGE_KEY = "sentry.local.stream-url";
export const REMOTE_STREAM_STORAGE_KEY = "sentry.local.remote-stream-url";
export const DEFAULT_STREAM_URL = "http://localhost:8969/stream";

export type StreamEndpointKind = "loopback" | "remote";

export type StreamEndpoint = {
  url: string;
  kind: StreamEndpointKind;
};

export type LocalFeedItem = {
  id: string;
  type: string;
  timestamp?: number | string;
  text: string;
  payload: unknown;
  metadata?: EventMetadata;
  envelopeHeader?: Record<string, unknown>;
  itemHeader?: Record<string, unknown>;
};

export type EventMetadata = {
  title: string;
  message?: string;
  level?: string;
  method?: string;
  route?: string;
  statusCode?: number;
  spanStatus?: string;
  durationMs?: number;
  traceId?: string;
  spanId?: string;
  operation?: string;
  origin?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function getAttributeValue(
  attributes: Record<string, unknown>,
  key: string,
): unknown {
  const attribute = attributes[key];
  return isRecord(attribute) ? attribute.value : attribute;
}

function getAttributeString(
  attributes: Record<string, unknown>,
  key: string,
): string | undefined {
  return getString(getAttributeValue(attributes, key));
}

function getRoute(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url.startsWith("/") ? url : undefined;
  }
}

function contextFeedback(
  event: Record<string, unknown>,
): Record<string, unknown> {
  const contexts = isRecord(event.contexts) ? event.contexts : {};
  return isRecord(contexts.feedback) ? contexts.feedback : {};
}

/** Derive display metadata from this payload without inheriting its parent event. */
export function getEventMetadata(
  payload: unknown,
  type: string,
): EventMetadata {
  const event = isRecord(payload) ? payload : {};
  const exception =
    type === "event" ? getEventExceptions(payload)[0] : undefined;
  const transaction = getString(event.transaction);
  const description = getString(event.description);
  const message =
    getString(event.message) ??
    getString(event.body) ??
    getString(event.name) ??
    getString(
      isRecord(contextFeedback(event))
        ? contextFeedback(event).message
        : undefined,
    );
  const transactionMatch = transaction?.match(/^([A-Z]+)\s+(.+)$/);
  const contexts = isRecord(event.contexts) ? event.contexts : {};
  const trace = isRecord(contexts.trace) ? contexts.trace : event;
  const data = isRecord(trace.data)
    ? trace.data
    : isRecord(event.data)
      ? event.data
      : {};
  const attributes = isRecord(event.attributes) ? event.attributes : {};
  const spanAttributes = type === "span" ? attributes : {};
  const request = isRecord(event.request) ? event.request : {};
  const method =
    getString(request.method) ??
    getString(data["http.method"]) ??
    getAttributeString(spanAttributes, "http.request.method") ??
    transactionMatch?.[1];
  const url =
    getString(request.url) ??
    getString(data["http.url"]) ??
    getAttributeString(spanAttributes, "url.full");
  const route = getRoute(url) ?? transactionMatch?.[2];
  const startTimestamp = getNumber(event.start_timestamp);
  const timestamp =
    getNumber(event.timestamp) ?? getNumber(event.end_timestamp);
  const durationMs =
    startTimestamp !== undefined && timestamp !== undefined
      ? Math.round((timestamp - startTimestamp) * 100_000) / 100
      : undefined;

  return {
    title:
      (exception?.type || exception?.value
        ? formatExceptionTitle(exception)
        : undefined) ??
      (type === "event" ? message : undefined) ??
      transaction ??
      description ??
      message ??
      route ??
      (exception ? formatExceptionTitle(exception) : undefined) ??
      type,
    ...(type === "event" && message ? { message } : {}),
    level: getString(event.level),
    method,
    route,
    statusCode:
      getNumber(request.status_code) ??
      getNumber(data["http.response.status_code"]) ??
      getNumber(getAttributeValue(spanAttributes, "http.response.status_code")),
    spanStatus: getString(trace.status) ?? getString(event.status),
    durationMs,
    traceId: getString(trace.trace_id) ?? getString(event.trace_id),
    spanId: getString(trace.span_id) ?? getString(event.span_id),
    operation:
      getString(trace.op) ??
      getString(event.op) ??
      getString(event.transaction_op) ??
      getAttributeString(attributes, "sentry.op"),
    origin:
      getString(data["sentry.origin"]) ??
      getString(event.origin) ??
      getAttributeString(attributes, "sentry.origin"),
  };
}

function getBatchedPayloadItems(payload: unknown, type: string): unknown[] {
  if (type === "span") {
    if (!isRecord(payload)) return [];
    const isContainer = "items" in payload;
    if (isContainer && (payload.version !== 2 || !Array.isArray(payload.items)))
      return [];
    const spans: unknown[] = isContainer
      ? (payload.items as unknown[])
      : [payload];
    return spans.filter(
      (span) =>
        isRecord(span) &&
        getString(span.trace_id) !== undefined &&
        getString(span.span_id) !== undefined &&
        getNumber(span.start_timestamp) !== undefined &&
        getNumber(
          isContainer
            ? span.end_timestamp
            : (span.timestamp ?? span.end_timestamp),
        ) !== undefined,
    );
  }
  if (type !== "log" || !isRecord(payload) || !Array.isArray(payload.items)) {
    return [payload];
  }
  return payload.items.filter(isRecord);
}

function getItemTimestamp(payload: unknown): number | string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const timestamp = payload.timestamp ?? payload.end_timestamp;
  return typeof timestamp === "number" || typeof timestamp === "string"
    ? timestamp
    : undefined;
}

/** Normalize an explicit connection target and classify its persistence policy. */
export function parseStreamEndpoint(
  stream: string | null,
): StreamEndpoint | undefined {
  if (!stream) {
    return undefined;
  }
  try {
    const url = new URL(stream);
    const daemonStream = /^\/_local\/v1\/sessions\/[^/]+\/stream$/.test(
      url.pathname,
    );
    if (
      (!daemonStream && url.pathname !== "/stream") ||
      url.username ||
      url.password ||
      url.hash
    ) {
      return undefined;
    }
    if (isLoopbackHost(url.hostname)) {
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        (!daemonStream && url.search) ||
        (daemonStream && !url.searchParams.get("cap"))
      ) {
        return undefined;
      }
      return { url: url.toString(), kind: "loopback" };
    }
    if (url.protocol === "https:") {
      return { url: url.toString(), kind: "remote" };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function normalizeLoopbackStreamUrl(stream: string | null): string | undefined {
  const endpoint = parseStreamEndpoint(stream);
  return endpoint?.kind === "loopback" ? endpoint.url : undefined;
}

function normalizeRemoteStreamUrl(stream: string | null): string | undefined {
  const endpoint = parseStreamEndpoint(stream);
  return endpoint?.kind === "remote" ? endpoint.url : undefined;
}

/** Read the CLI-provided stream endpoint without allowing arbitrary targets. */
export function getStreamUrlFromHash(hash: string): string | undefined {
  return normalizeLoopbackStreamUrl(
    new URLSearchParams(hash.replace(/^#/, "")).get("stream"),
  );
}

/** Public viewer query links may select only a credential-free loopback receiver. */
export function getStreamUrlFromQuery(search: string): string | undefined {
  const endpoint = parseStreamEndpoint(new URLSearchParams(search).get("url"));
  if (endpoint?.kind !== "loopback") return;
  const url = new URL(endpoint.url);
  return url.pathname === "/stream" && !url.search ? endpoint.url : undefined;
}

/** Validate a stream endpoint saved by an earlier CLI-launched tab. */
export function getStreamUrlFromStorage(
  stream: string | null,
): string | undefined {
  return normalizeLoopbackStreamUrl(stream);
}

/** Validate an explicit remote stream saved for the current browser session. */
export function getRemoteStreamUrlFromStorage(
  stream: string | null,
): string | undefined {
  return normalizeRemoteStreamUrl(stream);
}

/** Prefer a newly supplied CLI endpoint over a previously saved one. */
export function getPreferredStreamUrl(
  hash: string,
  savedStream: string | null,
): string | undefined {
  return getStreamUrlFromHash(hash) ?? getStreamUrlFromStorage(savedStream);
}

/** Explicit startup links precede this tab's remote choice and the shared local default. */
export function resolveInitialStreamUrl(
  hash: string,
  savedLoopbackStream: string | null,
  savedRemoteStream: string | null,
  search = "",
): string {
  return (
    getStreamUrlFromHash(hash) ??
    getStreamUrlFromQuery(search) ??
    getRemoteStreamUrlFromStorage(savedRemoteStream) ??
    getStreamUrlFromStorage(savedLoopbackStream) ??
    DEFAULT_STREAM_URL
  );
}

/** Decode the event payload emitted by the local receiver's SSE endpoint. */
export function decodeEnvelope(data: string, eventId: string): LocalFeedItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new Error("Invalid Sentry envelope");
  }

  if (!Array.isArray(parsed) || !Array.isArray(parsed[1])) {
    throw new Error("Invalid Sentry envelope");
  }

  return parsed[1].flatMap((item, index) => {
    if (!Array.isArray(item) || item.length < 2 || !isRecord(item[0])) {
      return [];
    }
    const header = item[0];
    const type = typeof header.type === "string" ? header.type : "unknown";
    const payloads = getBatchedPayloadItems(item[1], type);
    return payloads.map((payload, payloadIndex) => ({
      id:
        payloads.length === 1
          ? `${eventId}:${index}`
          : `${eventId}:${index}:${payloadIndex}`,
      type,
      envelopeHeader: isRecord(parsed[0]) ? parsed[0] : {},
      itemHeader: header,
      timestamp: getItemTimestamp(payload),
      text: JSON.stringify(payload, null, 2) ?? String(payload),
      payload,
      metadata: {
        ...getEventMetadata(payload, type),
        ...(type === "attachment" && typeof header.filename === "string"
          ? { title: header.filename }
          : {}),
      },
    }));
  });
}
