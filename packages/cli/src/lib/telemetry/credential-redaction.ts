/** Redact outgoing SDK envelopes without modifying live scopes or caller data. */

import { type Envelope, normalize } from "@sentry/core";
import { redactCredentialText } from "../credential-redaction.js";

/** Materialize the same JSON as the SDK before redacting a detached copy. */
function redactJson<T>(value: T): T {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    // This is the SDK's envelope serialization fallback for cycles and BigInt.
    serialized = JSON.stringify(normalize(value));
  }
  const copy: T = JSON.parse(serialized ?? "null");
  if (typeof copy === "string") {
    return redactCredentialText(copy) as T;
  }
  const pending: unknown[] = [copy];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== "object") {
      continue;
    }
    for (const [key, nested] of Object.entries(current)) {
      if (typeof nested === "string") {
        (current as Record<string, unknown>)[key] =
          redactCredentialText(nested);
      } else {
        pending.push(nested);
      }
    }
  }
  return copy;
}

/**
 * Scrub the final envelope, after SDK metadata and log attributes are resolved.
 * JSON materialization preserves boxed values/toJSON without mutating live
 * scopes, client options, or caller-owned objects. Binary attachments stay intact.
 */
export function redactTelemetryEnvelope(envelope: Envelope): Envelope {
  return [
    redactJson(envelope[0]),
    envelope[1].map(([headers, payload]) => {
      const safeHeaders = redactJson(headers);
      const safePayload =
        payload instanceof Uint8Array ? payload : redactJson(payload);
      if (typeof safePayload === "string" && headers.length !== undefined) {
        safeHeaders.length = Buffer.byteLength(safePayload, "utf8");
      }
      return [safeHeaders, safePayload];
    }),
  ] as Envelope;
}
