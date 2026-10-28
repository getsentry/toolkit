import type { Envelope } from "@sentry/core";
import { SUPPORTED_EVENT_TYPES } from "../constants/sentry.ts";
import { opaquePayload } from "../envelope/payload.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function validateEnvelope(input: unknown): input is Envelope {
  if (
    !Array.isArray(input) ||
    input.length !== 2 ||
    !isRecord(input[0]) ||
    !Array.isArray(input[1])
  )
    return false;
  return input[1].every(
    (item) =>
      Array.isArray(item) &&
      item.length === 2 &&
      isRecord(item[0]) &&
      typeof item[0].type === "string" &&
      ((isRecord(item[1]) && !(item[1] instanceof Uint8Array)) ||
        (!SUPPORTED_EVENT_TYPES.has(item[0].type) &&
          item[0].type !== "span" &&
          (typeof item[1] === "string" || item[1] instanceof Uint8Array))),
  );
}

/** Match serialized opaque items with the shared portable byte policy. */
export function normalizeEnvelope(input: Envelope): Envelope {
  const envelope = structuredClone(input);
  for (const item of envelope[1]) {
    const [header, payload] = item;
    if (typeof payload !== "string" && !(payload instanceof Uint8Array))
      continue;
    if (!header.content_type && (header.type as string) === "statsd")
      header.content_type = "text/plain";
    item[1] = opaquePayload(
      payload,
      header.content_type as string,
    ) as (typeof item)[1];
  }
  return envelope;
}
export function supportsEnvelope(input: Envelope): boolean {
  return input[1].some(([header, payload]) => {
    if (header.type !== "span") return SUPPORTED_EVENT_TYPES.has(header.type);
    const span = payload as Record<string, unknown>;
    return (
      !("items" in span) || (span.version === 2 && Array.isArray(span.items))
    );
  });
}
