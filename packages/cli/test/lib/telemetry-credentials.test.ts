import {
  _INTERNAL_flushLogsBuffer,
  type Envelope,
  type ErrorEvent,
  type Transport,
} from "@sentry/core";
import {
  captureEvent,
  captureException,
  getCurrentScope,
  getIsolationScope,
  logger,
  setContext,
  startSpan,
  withScope,
} from "@sentry/node-core/light";
import { afterEach, describe, expect, test, vi } from "vitest";
import { extractMessagePrefix } from "../../src/lib/error-reporting.js";
import { redactTelemetryEnvelope } from "../../src/lib/telemetry/credential-redaction.js";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- spy on the outbound transport factory
import * as transportModule from "../../src/lib/telemetry/zstd-transport.js";
import { initSentry } from "../../src/lib/telemetry.js";

const token = "sntrys_SYNTHETIC_PAYLOAD\n_SYNTHETIC_SECRET";
const headerError = `Headers.set: "Bearer ${token}" is an invalid header value.`;
let client: ReturnType<typeof initSentry>;

/** Intercept the delegated delivery boundary while keeping the real SDK pipeline. */
function captureTelemetry() {
  const send = vi.fn<Transport["send"]>().mockResolvedValue({});
  const flush = vi.fn<Transport["flush"]>().mockResolvedValue(true);
  vi.spyOn(transportModule, "makeCompressedTransport").mockReturnValue({
    send,
    flush,
  });
  client = initSentry(false, { libraryMode: true });
  if (!client) {
    throw new Error("Expected the telemetry client");
  }
  // Enable capture only after every delivery route is intercepted.
  client.getOptions().enabled = true;
  client.getOptions().enableLogs = true;
  client.init();
  function serializedEnvelope(type: string): string {
    const envelope = send.mock.calls.find(([entry]) =>
      entry[1].some(([header]) => header.type === type),
    )?.[0];
    if (!envelope) {
      throw new Error(`Expected a ${type} envelope`);
    }
    return JSON.stringify(envelope);
  }
  return { client, send, flush, serializedEnvelope };
}

afterEach(async () => {
  await client?.close(0);
  getCurrentScope().clear();
  getIsolationScope().clear();
  vi.restoreAllMocks();
});

describe("telemetry credential boundaries", () => {
  test("sanitizes exceptions and related fields in the outgoing envelope", async () => {
    const capture = captureTelemetry();
    const event: ErrorEvent = {
      type: undefined,
      message: headerError,
      exception: {
        values: [
          { type: "TypeError", value: headerError },
          { type: "Error", value: `Wrapping ${token}` },
        ],
      },
      tags: { "cli_error.kind": token },
      contexts: { cli_error: { detail: headerError, status: 500 } },
      extra: { stack: headerError },
      breadcrumbs: [{ message: headerError, data: { token } }],
    };
    captureEvent(event);
    await capture.client.flush(1000);

    const serialized = capture.serializedEnvelope("event");
    expect(serialized).not.toContain("SYNTHETIC");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain('"status":500');
    expect(event.contexts?.cli_error?.detail).toBe(headerError);
  });

  test("scrubs exception causes in the outgoing Sentry envelope", async () => {
    const capture = captureTelemetry();
    captureException(
      new TypeError(headerError, { cause: new Error(`Rejected ${token}`) }),
    );
    await capture.client.flush(1000);

    const serialized = capture.serializedEnvelope("event");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("TypeError");
    expect(serialized).toContain("Rejected");
    expect(serialized).not.toContain("SYNTHETIC");
  });

  test("scrubs logs after the SDK adds scope attributes and fmt parameters", async () => {
    const capture = captureTelemetry();
    const frozen = Object.freeze({ token });
    // regression coverage for boxed log parameters
    const boxed = new String(token);
    withScope((scope) => {
      scope.setAttribute("scope.token", token);
      logger.error(logger.fmt`Rejected ${boxed}`, {
        nested: frozen,
        serialized: { toJSON: () => token },
        status: 500,
      });
    });
    _INTERNAL_flushLogsBuffer(capture.client);
    await capture.client.flush(1000);

    const serialized = capture.serializedEnvelope("log");
    expect(serialized).not.toContain("SYNTHETIC");
    expect(serialized).toContain("scope.token");
    expect(serialized).toContain("sentry.message.parameter.0");
    expect(serialized).toContain("Rejected [REDACTED]");
    expect(frozen.token).toBe(token);
    expect(String(boxed)).toBe(token);
  });

  test("does not traverse live scopes or client options when scrubbing a trace", async () => {
    const capture = captureTelemetry();
    const context = Object.freeze({ token });
    setContext("synthetic", context);
    capture.client.getOptions().release = token;
    startSpan({ name: "synthetic-review", forceTransaction: true }, (span) => {
      span.setAttribute("diagnostic", headerError);
    });
    capture.flush.mockResolvedValueOnce(false);
    await expect(capture.client.flush(1000)).resolves.toBe(false);

    expect(capture.send).toHaveBeenCalledOnce();
    const serialized = capture.serializedEnvelope("transaction");
    expect(serialized).not.toContain("SYNTHETIC");
    expect(context.token).toBe(token);
    expect(capture.client.getOptions().release).toBe(token);
    expect(capture.flush).toHaveBeenCalledWith(1000);
  });

  test("scrubs SDK internal errors that bypass beforeSend", async () => {
    const capture = captureTelemetry();
    setContext("synthetic", { token });
    capture.client.captureException(new Error(headerError), {
      data: { __sentry__: true },
    });
    await capture.client.flush(1000);

    expect(capture.send).toHaveBeenCalledOnce();
    const serialized = capture.serializedEnvelope("event");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("SYNTHETIC");
  });

  test("redacts before deriving a grouping key from the first line", () => {
    expect(extractMessagePrefix(headerError, 4)).toBe(
      "Headers.set: is an invalid",
    );
  });

  test("uses SDK serialization fallback for cycles and preserves binary attachments", () => {
    const data: { token: string; circular?: unknown } = { token };
    data.circular = data;
    const bytes = new Uint8Array([1, 2, 3]);
    const envelope: Envelope = [
      {},
      [
        [{ type: "event" }, { extra: data }],
        [
          { type: "attachment", length: bytes.length, filename: "test.bin" },
          bytes,
        ],
      ],
    ];
    const redacted = redactTelemetryEnvelope(envelope);
    expect(JSON.stringify(redacted)).not.toContain("SYNTHETIC");
    expect(JSON.stringify(redacted)).toContain("[Circular ~]");
    expect(redacted[1][1]?.[1]).toBe(bytes);
    expect(data.token).toBe(token);
    expect(data.circular).toBe(data);
  });
});
