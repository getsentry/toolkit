/** Private byte codec and structural contracts for the Node Local receiver. */
import { uuidv7 } from "uuidv7";
import { logger } from "../../lib/logger.js";
import { isLoopbackHost } from "./loopback.js";

type ItemHeader = Record<string, unknown> & { type?: string };
/** JSON-safe envelope tuple exposed to Local stream consumers. */
export type ParsedReceiverEnvelope = {
  /** Delivery header and items; opaque payloads carry text/base64 in `data`. */
  envelope: [
    Record<string, unknown> & { __spotlight_envelope_id: string },
    [ItemHeader, Record<string, unknown>][],
  ];
};
/** Lazily decoded delivery with byte-exact raw access and stable identity. */
export type ReceiverEnvelope = {
  /** Return the retained request buffer without serializing decoded data. */
  getData: () => Buffer;
  /** Return the normalized envelope media type. */
  getContentType: () => string;
  /** Decode once; null means malformed input remains raw-only. */
  getParsedEnvelope: () => ParsedReceiverEnvelope | null;
  /** Return item types, or null when the envelope cannot be decoded. */
  getEventTypes: () => string[] | null;
};
/** Receiver retention and resumable stream operations used by Local callers. */
export type ReceiverBuffer = {
  /** Retain a delivery and notify active subscribers. */
  put: (item: ReceiverEnvelope) => void;
  /** Read newest-first; default to the preceding 60 seconds. */
  read: (filters?: {
    /** Include all retained deliveries, without a default time window. */
    all?: boolean;
    /** Match the receiver-assigned delivery UUID. */
    envelopeId?: string;
    /** Match an exception frame's filename suffix. */
    filename?: string;
    /** Maximum delivery age in seconds. */
    timeWindow?: number;
  }) => ReceiverEnvelope[];
  /** Replay retained history after an optional delivery cursor, then follow. */
  subscribe: (
    callback: (item: ReceiverEnvelope) => void,
    lastEventId?: string,
  ) => string;
  /** Stop a subscription and cancel its scheduled history replay. */
  unsubscribe: (id: string) => void;
  /** Deliver history beyond a subscriber's current position once. */
  stream: (id: string) => void;
  /** Remove retained deliveries while preserving live subscriptions. */
  clear: () => void;
  /** Clear deliveries and invalidate outstanding receiver admissions. */
  reset: () => void;
};

const identities = new WeakMap<ReceiverEnvelope, string>();
/** Epoch milliseconds when each delivery received its identity. */
const receivedTimes = new WeakMap<ReceiverEnvelope, number>();

/** Record a delivery's identity and the time it was received. */
function trackDelivery(container: ReceiverEnvelope, id: string): void {
  identities.set(container, id);
  receivedTimes.set(container, Date.now());
}

// Item payloads that are not one JSON document even without a content type:
// replay recordings are a JSON line plus (usually gzip) rrweb bytes.
const RAW_TYPES = new Set([
  "attachment",
  "replay_recording",
  "replay_video",
  "statsd",
]);
const TEXT_CONTENT_TYPES = new Set([
  "text/plain",
  "text/css",
  "text/csv",
  "text/html",
  "text/javascript",
  "text/json",
  "text/x-json",
  "application/json",
  "application/ld+json",
]);

function isEnvelopeObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !ArrayBuffer.isView(value)
  );
}

/** Give every raw delivery its own identity, including undecodable deliveries. */
export function prepareReceiverEnvelope(container: ReceiverEnvelope): string {
  const existing = identities.get(container);
  if (existing) return existing;
  const id = uuidv7();
  trackDelivery(container, id);
  const parse = container.getParsedEnvelope.bind(container);
  let attempted = false;
  let parsed: ParsedReceiverEnvelope | null = null;
  container.getParsedEnvelope = () => {
    if (!attempted) {
      attempted = true;
      try {
        const candidate = parse();
        if (
          candidate &&
          isEnvelopeObject(candidate.envelope[0]) &&
          candidate.envelope[1].every(
            ([header, payload]) =>
              isEnvelopeObject(header) && isEnvelopeObject(payload),
          )
        ) {
          candidate.envelope[0].__spotlight_envelope_id = id;
          parsed = candidate;
        }
      } catch {
        // Parsing must never control raw retention or lookup.
        logger.debug("Local receiver retained an undecodable envelope.");
      }
    }
    return parsed;
  };
  return id;
}

/** Return the delivery UUID independently of sender headers or parse success. */
export function receiverEnvelopeId(container: ReceiverEnvelope): string {
  return prepareReceiverEnvelope(container);
}

type FramedItem = { header: ItemHeader; headerBytes: Buffer; bytes: Buffer };

/** Parse JSON item bytes; undefined means they are not JSON. */
function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    logger.debug("Local receiver kept a non-JSON envelope item raw.");
    return undefined;
  }
}

/**
 * Return when the receiver accepted a delivery, in epoch milliseconds, or
 * `undefined` when that was not recorded.
 */
export function receiverEnvelopeReceivedAt(
  container: ReceiverEnvelope,
): number | undefined {
  prepareReceiverEnvelope(container);
  return receivedTimes.get(container);
}

/**
 * Sentry framing uses byte lengths, not lines, for opaque and multiline items.
 * Unlike @sentry/core's transport parser, reject truncated lengths.
 */
function frame(body: Buffer): {
  header: Record<string, unknown>;
  headerBytes: Buffer;
  items: FramedItem[];
} | null {
  let offset = 0;
  function line(): Buffer {
    const newline = body.indexOf(10, offset);
    const end = newline < 0 ? body.length : newline;
    const bytes = body.subarray(offset, end);
    offset = newline < 0 ? body.length : end + 1;
    return bytes;
  }
  const headerBytes = line();
  const header: unknown = JSON.parse(headerBytes.toString("utf8"));
  if (!isEnvelopeObject(header)) return null;
  const items: FramedItem[] = [];
  while (offset < body.length) {
    const itemHeaderBytes = line();
    const item: unknown = JSON.parse(itemHeaderBytes.toString("utf8"));
    if (
      !isEnvelopeObject(item) ||
      (item.type !== undefined && typeof item.type !== "string")
    )
      return null;
    const itemHeader = item as ItemHeader;
    let bytes: Buffer;
    if (itemHeader.length !== undefined) {
      const length = itemHeader.length;
      if (
        typeof length !== "number" ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > body.length - offset
      )
        return null;
      const end = offset + length;
      if (end < body.length && body[end] !== 10) return null;
      bytes = body.subarray(offset, end);
      offset = end < body.length ? end + 1 : end;
    } else {
      if (offset === body.length) return null;
      bytes = line();
    }
    items.push({ header: itemHeader, headerBytes: itemHeaderBytes, bytes });
  }
  return { header, headerBytes, items };
}

/** Retain opaque items as JSON-safe text/base64 objects for the Local stream protocol. */
function decode(
  body: Buffer,
  id: string,
  userAgent?: string,
): ParsedReceiverEnvelope["envelope"] | null {
  const framed = frame(body);
  if (!framed) return null;
  const { header } = framed;
  const items: ParsedReceiverEnvelope["envelope"][1] = [];
  for (const { header: itemHeader, bytes } of framed.items) {
    const contentType =
      typeof itemHeader.content_type === "string"
        ? itemHeader.content_type
        : "";
    const metaLength = itemHeader.meta_length;
    let payload: Record<string, unknown> | undefined;
    if (
      typeof metaLength === "number" &&
      Number.isSafeInteger(metaLength) &&
      metaLength >= 0 &&
      metaLength <= bytes.length
    ) {
      // Android Perfetto profile chunks: JSON metadata, then a binary trace.
      const metadata = parseJson(bytes.subarray(0, metaLength));
      if (isEnvelopeObject(metadata))
        payload = {
          ...metadata,
          data: bytes.subarray(metaLength).toString("base64"),
        };
    } else if (
      // `json` also matches `+json` suffixes and sentry-java's `application-json`.
      !RAW_TYPES.has(itemHeader.type ?? "") &&
      (!contentType || contentType.includes("json"))
    ) {
      const parsed = parseJson(bytes);
      if (parsed !== undefined && !isEnvelopeObject(parsed)) return null;
      payload = parsed;
    }
    if (payload) {
      if (itemHeader.type) payload.type = itemHeader.type;
    } else {
      // Opaque or non-JSON items stay raw; the rest of the envelope decodes.
      if (itemHeader.type === "statsd" && !contentType)
        itemHeader.content_type = "text/plain";
      payload = {
        data: bytes.toString(
          TEXT_CONTENT_TYPES.has(
            typeof itemHeader.content_type === "string"
              ? itemHeader.content_type
              : "",
          )
            ? "utf8"
            : "base64",
        ),
      };
    }
    items.push([itemHeader, payload]);
  }
  header.__spotlight_envelope_id = id;
  if (userAgent) header.__spotlight_sender_user_agent = userAgent;
  return [{ ...header, __spotlight_envelope_id: id }, items];
}

function effectivePort(url: URL): string {
  return url.port || (url.protocol === "https:" ? "443" : "80");
}

/**
 * Match URLs of this receiver's own ingest and stream routes. The port comes
 * from the request URL (its Host header), which is direct on Local's
 * loopback-only listeners; a port-stripping proxy would make it match `:80`.
 */
function ownRouteMatcher(receiverUrl: string): (value: unknown) => boolean {
  const port = effectivePort(new URL(receiverUrl));
  return (value) => {
    if (typeof value !== "string") return false;
    // Span names and descriptions read `METHOD URL`.
    const candidate = value.slice(value.lastIndexOf(" ") + 1);
    if (!URL.canParse(candidate)) return false;
    const url = new URL(candidate);
    return (
      isLoopbackHost(url.hostname) &&
      effectivePort(url) === port &&
      (url.pathname === "/stream" || url.pathname.startsWith("/_local/"))
    );
  };
}

/** Legacy spans carry `op`/`data`; v2 spans carry typed `attributes`. */
function isOwnRequestSpan(
  span: unknown,
  isOwnRoute: (value: unknown) => boolean,
): boolean {
  if (!isEnvelopeObject(span)) return false;
  const data = isEnvelopeObject(span.data) ? span.data : {};
  const attributes = isEnvelopeObject(span.attributes) ? span.attributes : {};
  const field = (key: string): unknown => {
    const attribute = attributes[key];
    return (
      data[key] ?? (isEnvelopeObject(attribute) ? attribute.value : attribute)
    );
  };
  return (
    (span.op ?? field("sentry.op")) === "http.client" &&
    [
      field("url.full"),
      field("http.url"),
      field("url"),
      span.description,
      span.name,
    ].some(isOwnRoute)
  );
}

/** Remove matching entries from `holder[key]`; report whether any matched. */
function prune(
  holder: Record<string, unknown>,
  key: string,
  matches: (value: unknown) => boolean,
): boolean {
  const list = holder[key];
  if (!Array.isArray(list)) return false;
  const kept = list.filter((value) => !matches(value));
  if (kept.length === list.length) return false;
  holder[key] = kept;
  return true;
}

/** Remove own-request spans and breadcrumbs; null drops the whole item. */
function withoutOwnRequests(
  item: FramedItem,
  isOwnRoute: (value: unknown) => boolean,
): FramedItem | null {
  const { type } = item.header;
  if (type !== "span" && type !== "transaction" && type !== "event")
    return item;
  const payload = parseJson(item.bytes);
  if (!isEnvelopeObject(payload)) return item;
  const header: ItemHeader = { ...item.header };
  const isOwnSpan = (span: unknown) => isOwnRequestSpan(span, isOwnRoute);
  if (type === "span") {
    // Legacy standalone span, or a v2 container of spans.
    if (!Array.isArray(payload.items)) return isOwnSpan(payload) ? null : item;
    if (!prune(payload, "items", isOwnSpan)) return item;
    const { length } = payload.items as unknown[];
    if (!length) return null;
    if (header.item_count !== undefined) header.item_count = length;
  } else {
    const isOwnCrumb = (crumb: unknown) =>
      isEnvelopeObject(crumb) &&
      isEnvelopeObject(crumb.data) &&
      isOwnRoute(crumb.data.url);
    // Breadcrumbs are a list (JavaScript) or `{ values }` (Python).
    const crumbsPruned = isEnvelopeObject(payload.breadcrumbs)
      ? prune(payload.breadcrumbs, "values", isOwnCrumb)
      : prune(payload, "breadcrumbs", isOwnCrumb);
    const spansPruned = prune(payload, "spans", isOwnSpan);
    if (!crumbsPruned && !spansPruned) return item;
  }
  const bytes = Buffer.from(JSON.stringify(payload));
  header.length = bytes.length;
  return { header, headerBytes: Buffer.from(JSON.stringify(header)), bytes };
}

/**
 * Browser and Python SDKs instrument their own POSTs to Local, and each
 * resulting span is delivered by another instrumented POST. Remove http.client
 * spans and breadcrumbs that target this receiver's loopback `/_local/` or
 * `/stream` routes. Returns the body unchanged when none match, and null when
 * nothing else remains.
 */
export function withoutOwnDeliveries(
  body: Buffer,
  receiverUrl: string,
): Buffer | null {
  // Matching envelopes are parsed here and again by lazy decode; that costs
  // a few hundred milliseconds only for tens of thousands of spans.
  if (!body.includes("/_local/") && !body.includes("/stream")) return body;
  let framed: ReturnType<typeof frame>;
  let items: (FramedItem | null)[];
  try {
    framed = frame(body);
    if (!framed) return body;
    const isOwnRoute = ownRouteMatcher(receiverUrl);
    items = framed.items.map((item) => withoutOwnRequests(item, isOwnRoute));
  } catch {
    // Malformed envelopes stay byte-exact for raw inspection.
    logger.debug("Local receiver kept an undecodable envelope unfiltered.");
    return body;
  }
  if (items.every((item, index) => item === framed.items[index])) return body;
  const kept = items.filter((item) => item !== null);
  if (!kept.length) return null;
  const newline = Buffer.from("\n");
  return Buffer.concat([
    framed.headerBytes,
    ...kept.flatMap((item) => [newline, item.headerBytes, newline, item.bytes]),
  ]);
}

/** Retain raw bytes synchronously; decode lazily without allowing parse errors out. */
export function createReceiverEnvelope(input: {
  body: Buffer;
  contentType?: string;
  userAgent?: string;
}): ReceiverEnvelope {
  const contentType =
    input.contentType?.split(";")[0]?.trim().toLowerCase() ||
    "application/x-sentry-envelope";
  const id = uuidv7();
  let attempted = false;
  let parsed: ParsedReceiverEnvelope | null = null;
  const container: ReceiverEnvelope = {
    getData: () => input.body,
    getContentType: () => contentType,
    getParsedEnvelope() {
      if (!attempted) {
        attempted = true;
        try {
          const envelope = decode(input.body, id, input.userAgent);
          if (envelope) parsed = { envelope };
        } catch {
          // Malformed input remains available byte-for-byte in raw retention.
          logger.debug("Local receiver retained an undecodable envelope.");
        }
      }
      return parsed;
    },
    getEventTypes: () =>
      container
        .getParsedEnvelope()
        ?.envelope[1].flatMap(([header]) =>
          header.type ? [header.type] : [],
        ) ?? null,
  };
  trackDelivery(container, id);
  return container;
}
