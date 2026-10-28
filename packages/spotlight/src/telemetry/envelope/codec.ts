import type { Envelope, EnvelopeItem } from "@sentry/core";
import { type UUID, uuidv7obj } from "uuidv7";
import { RAW_TYPES, SUPPORTED_EVENT_TYPES } from "../constants/sentry.ts";
import { opaquePayload } from "./payload.ts";
import { type SourceType, inferEnvelopeSource } from "./source.ts";

/**
 * Spotlight-specific extensions added to envelope headers for internal tracking
 */
export type SpotlightEnvelopeExtensions = {
  __spotlight_envelope_id: UUID;
  __spotlight_sender_user_agent?: string;
  __spotlight_inferred_source?: SourceType;
};

export type DecodedEnvelope = [
  Envelope[0] & SpotlightEnvelopeExtensions,
  Envelope[1],
];

/**
 * Implements parser for
 * @see https://develop.sentry.dev/sdk/envelopes/#serialization-format
 * @param data Serialized UTF-8 envelope bytes
 * @param senderUserAgent Optional User-Agent header from the HTTP request sending the envelope
 * @param reportError Optional error observer; silent by default
 * @param strict Reject truncated payloads and invalid explicit lengths
 * @returns parsed envelope
 */
export function decodeEnvelope(
  data: Uint8Array,
  senderUserAgent?: string,
  reportError: (error: unknown) => void = () => {},
  strict = false,
): DecodedEnvelope | null {
  let buffer = data;

  function readLine(length?: number) {
    const cursor = length ?? getLineEnd(buffer);
    const line = buffer.subarray(0, cursor);
    buffer = buffer.subarray(cursor + 1);
    return line;
  }

  const envelopeHeader = parseJSONFromBuffer(
    readLine(),
    reportError,
  ) as Envelope[0];
  if (
    !envelopeHeader ||
    typeof envelopeHeader !== "object" ||
    Array.isArray(envelopeHeader)
  ) {
    reportError("Malformed envelope header, skipping...");
    return null;
  }

  envelopeHeader.__spotlight_envelope_id = uuidv7obj();

  // Store sender User-Agent for improved SDK categorization
  if (senderUserAgent) {
    envelopeHeader.__spotlight_sender_user_agent = senderUserAgent;
  }

  const items: EnvelopeItem[] = [];
  while (buffer.length) {
    if (strict && buffer.indexOf(0xa) === -1) {
      reportError("Truncated envelope item header, skipping envelope...");
      return null;
    }
    const itemHeader = parseJSONFromBuffer(
      readLine(),
      reportError,
    ) as EnvelopeItem[0];
    if (
      !itemHeader ||
      typeof itemHeader !== "object" ||
      Array.isArray(itemHeader)
    ) {
      reportError("Malformed envelope item header, skipping envelope...");
      return null;
    }
    const payloadLength = itemHeader.length;
    // Permissive mode allows truncated payloads, never invalid buffer indices.
    if (
      payloadLength !== undefined &&
      (!Number.isSafeInteger(payloadLength) || payloadLength < 0)
    ) {
      reportError("Malformed envelope item length, skipping envelope...");
      return null;
    }
    if (
      strict &&
      payloadLength !== undefined &&
      (payloadLength > buffer.length ||
        (payloadLength < buffer.length && buffer[payloadLength] !== 0xa))
    ) {
      reportError("Malformed envelope item length, skipping envelope...");
      return null;
    }
    const itemPayloadRaw = readLine(payloadLength);

    let itemPayload: EnvelopeItem[1];
    try {
      if (
        RAW_TYPES.has(itemHeader.type) ||
        (strict &&
          !SUPPORTED_EVENT_TYPES.has(itemHeader.type) &&
          itemHeader.type !== "span")
      ) {
        if (
          !itemHeader.content_type &&
          // @ts-expect-error -- statsd is an old and deprecated event type but have envelopes for that
          itemHeader.type === "statsd"
        ) {
          // @ts-expect-error -- same as above
          itemHeader.content_type = "text/plain";
        }
        itemPayload = opaquePayload(
          itemPayloadRaw,
          itemHeader.content_type as string,
        ) as EnvelopeItem[1];
      } else {
        itemPayload = parseJSONFromBuffer(itemPayloadRaw, reportError);
        if (!itemPayload) {
          reportError(itemHeader);
        } else if (itemHeader.type) {
          // data sanitization
          // @ts-expect-error ts(2339) -- We should really stop adding type to payloads
          itemPayload.type = itemHeader.type;
        }
      }
    } catch (err) {
      itemPayload = itemPayloadRaw;
      reportError(err);
    }

    items.push([itemHeader, itemPayload] as EnvelopeItem);
  }

  // Infer the envelope source (browser, server, or mobile) for UI display
  // Scan all events to find a deterministic match
  const eventPayloads = items.map(([, payload]) => payload);
  envelopeHeader.__spotlight_inferred_source = inferEnvelopeSource(
    envelopeHeader,
    eventPayloads,
  );

  return [envelopeHeader, items] as DecodedEnvelope;
}

function getLineEnd(data: Uint8Array): number {
  let end = data.indexOf(0xa);
  if (end === -1) {
    end = data.length;
  }

  return end;
}

function parseJSONFromBuffer<T = unknown>(
  data: Uint8Array,
  reportError: (error: unknown) => void,
): T {
  try {
    return JSON.parse(new TextDecoder().decode(data)) as T;
  } catch (err) {
    reportError(err);
    return null as T;
  }
}
