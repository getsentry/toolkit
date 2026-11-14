/** Private byte codec and structural contracts for the Node Local receiver. */
import { uuidv7 } from "uuidv7";
import { logger } from "../../lib/logger.js";

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
const RAW_TYPES = new Set(["attachment", "replay_video", "statsd"]);
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
  identities.set(container, id);
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

/**
 * Sentry framing uses byte lengths, not lines, for opaque and multiline items.
 * Unlike @sentry/core's transport parser, reject truncated lengths and retain
 * opaque items as JSON-safe text/base64 objects for the Local stream protocol.
 */
function decode(
  body: Buffer,
  id: string,
  userAgent?: string,
): ParsedReceiverEnvelope["envelope"] | null {
  let offset = 0;
  function line(): Buffer {
    const newline = body.indexOf(10, offset);
    const end = newline < 0 ? body.length : newline;
    const bytes = body.subarray(offset, end);
    offset = newline < 0 ? body.length : end + 1;
    return bytes;
  }
  const header: unknown = JSON.parse(line().toString("utf8"));
  if (!isEnvelopeObject(header)) return null;
  const items: ParsedReceiverEnvelope["envelope"][1] = [];
  while (offset < body.length) {
    const item: unknown = JSON.parse(line().toString("utf8"));
    if (
      !isEnvelopeObject(item) ||
      (item["type"] !== undefined && typeof item["type"] !== "string")
    )
      return null;
    const itemHeader = item as ItemHeader;
    let bytes: Buffer;
    if (itemHeader["length"] !== undefined) {
      const length = itemHeader["length"];
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
    let payload: unknown;
    if (RAW_TYPES.has(itemHeader.type ?? "")) {
      if (itemHeader.type === "statsd" && !itemHeader["content_type"])
        itemHeader["content_type"] = "text/plain";
      payload = {
        data: bytes.toString(
          TEXT_CONTENT_TYPES.has(
            typeof itemHeader["content_type"] === "string"
              ? itemHeader["content_type"]
              : "",
          )
            ? "utf8"
            : "base64",
        ),
      };
    } else {
      payload = JSON.parse(bytes.toString("utf8"));
      if (!isEnvelopeObject(payload)) return null;
      if (itemHeader.type) payload["type"] = itemHeader.type;
    }
    if (!isEnvelopeObject(payload)) return null;
    items.push([itemHeader, payload]);
  }
  header["__spotlight_envelope_id"] = id;
  if (userAgent) header["__spotlight_sender_user_agent"] = userAgent;
  return [{ ...header, __spotlight_envelope_id: id }, items];
}

/** Retain raw bytes synchronously; decode lazily without allowing parse errors out. */
export function createReceiverEnvelope(input: {
  body: Buffer;
  contentType?: string;
  userAgent?: string | undefined;
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
  identities.set(container, id);
  return container;
}
