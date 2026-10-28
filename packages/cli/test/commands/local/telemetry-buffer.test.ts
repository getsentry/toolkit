import { runInNewContext } from "node:vm";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { createLocalTelemetryBuffer } from "../../../src/commands/local/telemetry-buffer.js";
import {
  buildApp,
  buildSSEHandler,
} from "../../../src/commands/local/server.js";
import { createLocalControlPlane } from "../../../src/commands/local/control-plane.js";
import { SENTRY_CONTENT_TYPE } from "../../../src/lib/formatters/local.js";

const event = (id: string) =>
  `{"event_id":"${id}"}\n{"type":"event"}\n{"message":"hello"}`;

describe("shared telemetry receiver", () => {
  test("accepts streamed span v2 through the shared pipeline", async () => {
    const buffer = createLocalTelemetryBuffer();
    try {
      const app = buildApp(buffer);
      const response = await app.request("/api/42/envelope/", {
        method: "POST",
        headers: { "Content-Type": SENTRY_CONTENT_TYPE },
        body:
          '{}\n{"type":"span"}\n' +
          JSON.stringify({
            version: 2,
            items: [
              {
                trace_id: "a".repeat(32),
                span_id: "b".repeat(16),
                name: "SELECT 1",
                start_timestamp: 1000,
                end_timestamp: 1001,
                attributes: { "sentry.op": { type: "string", value: "db" } },
              },
            ],
          }),
      });
      expect(response.status).toBe(204);
      expect(buffer.pipeline.getSpans()).toHaveLength(1);
      expect(
        buffer.read({ all: true })[0]?.getParsedEnvelope().envelope[1][0]?.[0]
          .type,
      ).toBe("span");
    } finally {
      buffer.dispose();
    }
  });

  test.each([
    "not-json",
    '{}\n{"type":"event"}\nnot-json',
    '{}\n{"type":"attachment","length":99}\nshort',
  ])("rejects malformed input without retaining it: %s", async (body) => {
    const buffer = createLocalTelemetryBuffer();
    try {
      const response = await buildApp(buffer).request("/stream", {
        method: "POST",
        headers: { "Content-Type": SENTRY_CONTENT_TYPE },
        body,
      });
      expect(response.status).toBe(400);
      expect(buffer.read({ all: true })).toEqual([]);
    } finally {
      buffer.dispose();
    }
  });

  test.each([
    ["gzip", gzipSync],
    ["deflate", deflateSync],
    ["br", brotliCompressSync],
  ] as const)(
    "retains original decoded bytes after %s compression",
    async (encoding, compress) => {
      const buffer = createLocalTelemetryBuffer();
      try {
        const body = Buffer.from(event("raw"));
        const app = buildApp(buffer, { uiActions: true });
        const response = await app.request("/stream", {
          method: "POST",
          headers: {
            "Content-Type": SENTRY_CONTENT_TYPE,
            "Content-Encoding": encoding,
          },
          body: new Uint8Array(compress(body)),
        });
        expect(response.status).toBe(204);
        const container = buffer.read({ all: true })[0]!;
        const id = String(
          container.getParsedEnvelope().envelope[0].__spotlight_envelope_id,
        );
        const raw = await app.request(`/envelope/${id}`);
        expect(Buffer.from(await raw.arrayBuffer())).toEqual(body);
      } finally {
        buffer.dispose();
      }
    },
  );

  test.each([undefined, "text/plain; charset=UTF-8"])(
    "accepts legacy plain envelopes with media type %s",
    async (contentType) => {
      const buffer = createLocalTelemetryBuffer();
      try {
        const response = await buildApp(buffer).request("/stream", {
          method: "POST",
          headers: contentType ? { "Content-Type": contentType } : {},
          body: event("plain"),
        });
        expect(response.status).toBe(204);
        expect(buffer.read({ all: true })).toHaveLength(1);
      } finally {
        buffer.dispose();
      }
    },
  );

  test("rejects invalid compressed bodies without retaining them", async () => {
    const buffer = createLocalTelemetryBuffer();
    try {
      const response = await buildApp(buffer).request("/stream", {
        method: "POST",
        headers: {
          "Content-Type": SENTRY_CONTENT_TYPE,
          "Content-Encoding": "gzip",
        },
        body: "not gzip",
      });
      expect(response.status).toBe(400);
      expect(buffer.read({ all: true })).toEqual([]);
    } finally {
      buffer.dispose();
    }
  });

  test("delivers an admitted compressed envelope before the final session close frame", async () => {
    const plane = createLocalControlPlane({ controlToken: "test" });
    const session = plane.sessionStore.create({
      label: "closing",
      cwd: "/test",
    });
    const buffer = plane.sessionStore.getBuffer(session.id);
    const capability = plane.sessionStore.getCapabilities(session.id).stream;
    const response = await plane.app.request(
      `/_local/v1/sessions/${session.id}/stream?cap=${capability}`,
    );
    const reader = response.body!.getReader();
    try {
      await reader.read(); // Initial open-session metadata.
      const ingest = buffer.ingestPayload({
        body: gzipSync(event("before-close")),
        encoding: "gzip",
        contentType: SENTRY_CONTENT_TYPE,
      });
      plane.sessionStore.close(session.id);
      await ingest;
      let text = "";
      const decoder = new TextDecoder();
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        text += decoder.decode(next.value);
      }
      expect(text).toContain("before-close");
      expect(text.indexOf("before-close")).toBeLessThan(
        text.indexOf('"state":"retained"'),
      );
    } finally {
      await reader.cancel();
      buffer.dispose();
    }
  });

  test("keeps opaque attachment bytes and SSE base64 transport compatible", async () => {
    const buffer = createLocalTelemetryBuffer();
    try {
      const bytes = Buffer.from([0, 255, 10, 128]);
      const body = Buffer.concat([
        Buffer.from(
          '{}\n{"type":"attachment","length":4,"content_type":"application/octet-stream"}\n',
        ),
        bytes,
      ]);
      await buffer.ingestPayload({ body, contentType: SENTRY_CONTENT_TYPE });
      const container = buffer.read({ all: true })[0]!;
      expect(container.getData()).toEqual(body);
      const frames: { event?: string; data: string }[] = [];
      buildSSEHandler(
        {
          writeSSE: async (frame) => {
            frames.push(frame);
          },
        },
        true,
      )(container);
      expect(frames[0]?.event).toBe(`${SENTRY_CONTENT_TYPE};base64`);
      const parsed = JSON.parse(frames[0]!.data);
      expect(parsed[1][0][1].data).toBe(bytes.toString("base64"));
    } finally {
      buffer.dispose();
    }
  });

  test("replays after cursors, falls back for stale cursors, and keeps subscribers after clear", async () => {
    const buffer = createLocalTelemetryBuffer(2);
    try {
      for (const id of ["first", "second", "third"])
        await buffer.ingestPayload({
          body: event(id),
          contentType: SENTRY_CONTENT_TYPE,
        });
      const history = buffer.read({ all: true });
      const secondId = String(
        history[1]!.getParsedEnvelope().envelope[0].__spotlight_envelope_id,
      );
      const seen: string[] = [];
      const reader = buffer.subscribe(
        (item) =>
          seen.push(String(item.getParsedEnvelope().envelope[0].event_id)),
        secondId,
      );
      buffer.stream(reader);
      expect(seen).toEqual(["third"]);
      const stale: string[] = [];
      const staleReader = buffer.subscribe(
        (item) =>
          stale.push(String(item.getParsedEnvelope().envelope[0].event_id)),
        "unknown",
      );
      buffer.stream(staleReader);
      expect(stale).toEqual(["second", "third"]);
      buffer.clear();
      await buffer.ingestPayload({
        body: event("fourth"),
        contentType: SENTRY_CONTENT_TYPE,
      });
      expect(seen).toEqual(["third", "fourth"]);
      expect(buffer.pipeline.getEnvelopes()).toHaveLength(1);
    } finally {
      buffer.dispose();
    }
  });
});

test.each(["global", "scoped"] as const)(
  "%s receiver reports backpressure instead of acknowledging discarded burst deliveries",
  async (scope) => {
    const plane = createLocalControlPlane({ controlToken: "burst" });
    const session = plane.sessionStore.create({
      label: "burst",
      cwd: "/burst",
    });
    const buffer =
      scope === "global"
        ? createLocalTelemetryBuffer()
        : plane.sessionStore.getBuffer(session.id);
    const app = scope === "global" ? buildApp(buffer) : plane.app;
    const path =
      scope === "global"
        ? "/stream"
        : `/_local/v1/sessions/${session.id}/ingest/${plane.sessionStore.getCapabilities(session.id).ingest}`;
    try {
      const responses = await Promise.all(
        Array.from(
          { length: 100 },
          async (_, index) =>
            await app.request(path, {
              method: "POST",
              headers: { "Content-Type": SENTRY_CONTENT_TYPE },
              body: event(`burst-${index}`),
            }),
        ),
      );
      const accepted = responses.filter((response) => response.status === 204);
      const retry = responses.filter((response) => response.status === 503);
      expect(accepted.length + retry.length).toBe(100);
      expect(retry.length).toBeGreaterThan(0);
      expect(
        retry.every((response) => response.headers.get("Retry-After") === "1"),
      ).toBe(true);
      expect(buffer.read({ all: true })).toHaveLength(accepted.length);
    } finally {
      buffer.dispose();
      if (scope === "global")
        plane.sessionStore.getBuffer(session.id).dispose();
    }
  },
);

test("retention resize checks admitted compressed ingress before refusing destructive reductions", async () => {
  const { createLocalRetentionBuffer } =
    await import("../../../src/commands/local/retention-buffer.js");
  const retention = createLocalRetentionBuffer(3);
  const buffer = retention.buffer;
  try {
    await buffer.ingestPayload({ body: event("before") });
    const admitted = buffer.ingestPayload({
      body: gzipSync(event("during")),
      encoding: "gzip",
    });
    const resize = retention.resize(1);
    const later = buffer.ingestPayload({ body: event("after") });
    await expect(resize).rejects.toMatchObject({ status: 409 });
    await Promise.all([admitted, later]);
    expect(retention.getSettings()).toEqual({
      maxEnvelopes: 3,
      retainedEnvelopes: 3,
    });
    expect(
      buffer
        .read({ all: true })
        .map((item) => item.getParsedEnvelope().envelope[0].event_id),
    ).toEqual(["after", "during", "before"]);
  } finally {
    buffer.dispose();
  }
});

test("close waits for writes admitted behind a retention resize and keeps the session closed", async () => {
  const plane = createLocalControlPlane({ controlToken: "resize-close" });
  const session = plane.sessionStore.create({
    label: "resize-close",
    cwd: "/test",
    maxEnvelopes: 3,
  });
  const buffer = plane.sessionStore.getBuffer(session.id);
  const capability = plane.sessionStore.getCapabilities(session.id).stream;
  const response = await plane.app.request(
    `/_local/v1/sessions/${session.id}/stream?cap=${capability}`,
  );
  const reader = response.body!.getReader();
  try {
    await reader.read();
    const first = buffer.ingestPayload({
      body: gzipSync(event("before-resize")),
      encoding: "gzip",
    });
    const resize = plane.sessionStore.setMaxEnvelopes(session.id, 4);
    const deferred = buffer.ingestPayload({ body: event("after-resize") });
    plane.sessionStore.close(session.id);
    await Promise.all([first, resize, deferred]);
    expect(plane.sessionStore.resolve(session.id).state).toBe("retained");
    let text = "";
    const decoder = new TextDecoder();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      text += decoder.decode(next.value);
    }
    expect(text).toContain("before-resize");
    expect(text).toContain("after-resize");
    expect(text.indexOf("after-resize")).toBeLessThan(
      text.indexOf('"state":"retained"'),
    );
  } finally {
    await reader.cancel();
    buffer.dispose();
  }
});

test("clear cancels writes deferred behind retention controls and accepts new writes", async () => {
  const { createLocalRetentionBuffer } =
    await import("../../../src/commands/local/retention-buffer.js");
  const retention = createLocalRetentionBuffer(3);
  const buffer = retention.buffer;
  try {
    const first = buffer.ingestPayload({
      body: gzipSync(event("before-clear")),
      encoding: "gzip",
    });
    const resize = retention.resize(4);
    const deferred = buffer.ingestPayload({
      body: event("deferred-before-clear"),
    });
    buffer.clear();
    const fresh = buffer.ingestPayload({ body: event("after-clear") });
    await resize;
    expect(retention.getSettings().maxEnvelopes).toBe(4);
    expect(await first).toMatchObject({ status: "ignored", reason: "reset" });
    expect(await deferred).toMatchObject({
      status: "ignored",
      reason: "reset",
    });
    expect(await fresh).toMatchObject({ status: "processed" });
    await buffer.drain();
    expect(
      buffer
        .read({ all: true })
        .map((item) => item.getParsedEnvelope().envelope[0].event_id),
    ).toEqual(["after-clear"]);
  } finally {
    buffer.dispose();
  }
});

test("receiver drain excludes retention controls submitted after the barrier", async () => {
  const buffer = createLocalTelemetryBuffer();
  let release!: () => void;
  let releaseLater!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const laterGate = new Promise<void>((resolve) => {
    releaseLater = resolve;
  });
  try {
    const first = buffer.withWriteBarrier(async () => {
      await firstGate;
    });
    const ingress = buffer.ingestPayload({ body: event("earlier") });
    const drained = buffer.drain();
    const later = buffer.withWriteBarrier(async () => {
      await laterGate;
    });
    release();
    await drained;
    expect((await ingress).status).toBe("processed");
    releaseLater();
    await Promise.all([first, later]);
  } finally {
    release();
    releaseLater();
    buffer.dispose();
  }
});

test("clear releases admission capacity immediately for the new capture generation", async () => {
  const buffer = createLocalTelemetryBuffer();
  try {
    const old = Array.from({ length: 64 }, (_, index) =>
      buffer.ingestPayload({ body: event(`old-${index}`) }),
    );
    buffer.clear();
    const fresh = buffer.ingestPayload({ body: event("fresh") });
    expect(await fresh).toMatchObject({ status: "processed" });
    expect(
      (await Promise.all(old)).every(
        (receipt) => receipt.status === "ignored" && receipt.reason === "reset",
      ),
    ).toBe(true);
    expect(buffer.read({ all: true })).toHaveLength(1);
  } finally {
    buffer.dispose();
  }
});

test("copies cross-realm payload bytes before deferring them behind retention controls", async () => {
  const buffer = createLocalTelemetryBuffer();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const control = buffer.withWriteBarrier(async () => {
      await gate;
    });
    const body = runInNewContext("Uint8Array.from(bytes)", {
      bytes: [...Buffer.from(event("vm-copied"))],
    }) as Uint8Array;
    const ingress = buffer.ingestPayload({ body });
    body.fill(0);
    release();
    await control;
    expect(await ingress).toMatchObject({ status: "processed" });
    expect(
      buffer.read({ all: true })[0]?.getParsedEnvelope().envelope[0].event_id,
    ).toBe("vm-copied");
  } finally {
    release();
    buffer.dispose();
  }
});
