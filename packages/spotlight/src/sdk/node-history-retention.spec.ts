import { expect, test, vi } from "vitest";
import { createTelemetryPipeline } from "./node.ts";

function body(eventId: string): string {
  return `{}\n{"type":"event"}\n${JSON.stringify({ event_id: eventId, timestamp: 1 })}`;
}

test.each(["oversized", "within-budget"] as const)(
  "reusing an evicted delivery ID replaces decoded history: %s",
  async (scenario) => {
    const original = body("old");
    const other = body("other");
    const replacement =
      body("new") + " ".repeat(scenario === "oversized" ? 400 : 30);
    const pipeline = createTelemetryPipeline({
      retention: { maxEnvelopes: 1 },
      decodedHistory: {
        maxEntries: 10,
        maxBytes: Buffer.byteLength(original + other) + 10,
      },
    });
    try {
      await pipeline.ingestPayload({ body: original, deliveryId: "reused" });
      await pipeline.ingestPayload({ body: other, deliveryId: "other" });
      const expected = scenario === "oversized" ? undefined : replacement;
      const observed: (string | undefined)[] = [];
      pipeline.subscribe((_snapshot, change) => {
        if (change.type === "ingest")
          observed.push(pipeline.getDecodedPayload("reused")?.body.toString());
      });
      expect(
        await pipeline.ingestPayload({
          body: replacement,
          deliveryId: "reused",
        }),
      ).toMatchObject({ status: "processed" });
      expect(pipeline.getEvent("new")).toBeDefined();
      expect(pipeline.getDecodedPayload("reused")?.body.toString()).toBe(
        expected,
      );
      expect(observed).toEqual([expected]);
      expect(pipeline.getDecodedPayload("other")?.body.toString()).toBe(
        scenario === "oversized" ? other : undefined,
      );
    } finally {
      pipeline.dispose();
    }
  },
);

test("a re-admitted delivery becomes newest under the history entry limit", async () => {
  const pipeline = createTelemetryPipeline({
    retention: { maxEnvelopes: 1 },
    decodedHistory: { maxEntries: 2 },
  });
  try {
    await pipeline.ingestPayload({ body: body("old"), deliveryId: "reused" });
    await pipeline.ingestPayload({ body: body("other"), deliveryId: "other" });
    await pipeline.ingestPayload({ body: body("new"), deliveryId: "reused" });
    await pipeline.ingestPayload({
      body: body("latest"),
      deliveryId: "latest",
    });
    expect(pipeline.getDecodedPayload("reused")?.body.toString()).toBe(
      body("new"),
    );
    expect(pipeline.getDecodedPayload("other")).toBeUndefined();
    expect(pipeline.getDecodedPayload("latest")?.body.toString()).toBe(
      body("latest"),
    );
  } finally {
    pipeline.dispose();
  }
});

test("an oversized duplicate leaves the accepted delivery bytes intact", async () => {
  const original = body("original");
  const pipeline = createTelemetryPipeline({
    decodedHistory: { maxBytes: Buffer.byteLength(original) },
  });
  try {
    await pipeline.ingestPayload({ body: original, deliveryId: "same" });
    expect(
      await pipeline.ingestPayload({
        body: body("replacement") + " ".repeat(400),
        deliveryId: "same",
      }),
    ).toMatchObject({ status: "ignored", reason: "duplicate" });
    expect(pipeline.getDecodedPayload("same")?.body.toString()).toBe(original);
  } finally {
    pipeline.dispose();
  }
});

test("a parsed delivery clears old decoded bytes only after its ID is re-admitted", async () => {
  const pipeline = createTelemetryPipeline({ retention: { maxEnvelopes: 1 } });
  try {
    const parsed = [
      {},
      [[{ type: "event" }, { event_id: "parsed", timestamp: 1 }]],
    ];
    await pipeline.ingestPayload({ body: body("old"), deliveryId: "reused" });
    expect(
      await pipeline.ingestEnvelope(parsed, { deliveryId: "reused" }),
    ).toMatchObject({ status: "ignored", reason: "duplicate" });
    expect(pipeline.getDecodedPayload("reused")?.body.toString()).toBe(
      body("old"),
    );
    await pipeline.ingestPayload({ body: body("other"), deliveryId: "other" });
    const observed: (string | undefined)[] = [];
    pipeline.subscribe((_snapshot, change) => {
      if (change.type === "ingest")
        observed.push(pipeline.getDecodedPayload("reused")?.body.toString());
    });
    expect(
      await pipeline.ingestEnvelope(parsed, { deliveryId: "reused" }),
    ).toMatchObject({ status: "processed" });
    expect(pipeline.getEvent("parsed")).toBeDefined();
    expect(pipeline.getDecodedPayload("reused")).toBeUndefined();
    expect(observed).toEqual([undefined]);
    expect(pipeline.getDecodedPayload("other")?.body.toString()).toBe(
      body("other"),
    );
  } finally {
    pipeline.dispose();
  }
});

async function retainedDelivery() {
  vi.setSystemTime(1000);
  const pipeline = createTelemetryPipeline({ retention: { maxAgeMs: 15 } });
  await pipeline.ingestPayload({ body: body("expired"), deliveryId: "old" });
  vi.setSystemTime(1010);
  await pipeline.ingestPayload({ body: body("original"), deliveryId: "same" });
  // Move the clock without running the expiry timer. Admission must prune the
  // older envelope while retaining the original delivery that is redispatched.
  vi.setSystemTime(1021);
  return pipeline;
}

test("an eviction during duplicate admission cannot replace the original decoded delivery", async () => {
  vi.useFakeTimers();
  const pipeline = await retainedDelivery();
  try {
    const observations: { type: string; raw?: string }[] = [];
    pipeline.subscribe((_snapshot, change) => {
      observations.push({
        type: change.type,
        raw: pipeline.getDecodedPayload("same")?.body.toString(),
      });
    });
    expect(
      await pipeline.ingestPayload({
        body: body("replacement"),
        deliveryId: "same",
      }),
    ).toMatchObject({ status: "ignored", reason: "duplicate" });
    expect(observations).toEqual([{ type: "evict", raw: body("original") }]);
    expect(pipeline.getDecodedPayload("same")?.body.toString()).toBe(
      body("original"),
    );
    expect(pipeline.getEvent("original")).toBeDefined();
    expect(pipeline.getEvent("replacement")).toBeUndefined();
  } finally {
    pipeline.dispose();
    vi.useRealTimers();
  }
});

test("aborting a redispatch across retention rebuild awaits never commits its staged bytes", async () => {
  vi.useFakeTimers();
  let observedAbortedEviction = false;
  try {
    // Exercise cancellation on both sides of the rebuild's promise boundaries,
    // including the interval after pruning succeeds and before admission resumes.
    for (let abortAfter = 0; abortAfter <= 12; abortAfter++) {
      const pipeline = await retainedDelivery();
      try {
        const observations: { type: string; raw?: string }[] = [];
        pipeline.subscribe((_snapshot, change) => {
          observations.push({
            type: change.type,
            raw: pipeline.getDecodedPayload("same")?.body.toString(),
          });
        });
        const controller = new AbortController();
        const pending = pipeline.ingestPayload({
          body: body("replacement"),
          deliveryId: "same",
          signal: controller.signal,
        });
        for (let turn = 0; turn < abortAfter; turn++) await Promise.resolve();
        controller.abort();
        const result = await pending;
        expect(result.status).toBe("ignored");
        if (
          result.status === "ignored" &&
          result.reason === "aborted" &&
          observations.some((change) => change.type === "evict")
        )
          observedAbortedEviction = true;
        for (const observation of observations)
          expect(observation.raw).toBe(body("original"));
        expect(pipeline.getDecodedPayload("same")?.body.toString()).toBe(
          body("original"),
        );
        expect(pipeline.getEvent("replacement")).toBeUndefined();
      } finally {
        pipeline.dispose();
      }
    }
    expect(observedAbortedEviction).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test.each([
  { status: "processed", payload: body("newest") },
  { status: "ignored", payload: '{}\n{"type":"attachment","length":5}\nhello' },
] as const)(
  "$status payload bytes commit before observers even when byte retention immediately evicts the envelope",
  async ({ status, payload }) => {
    const pipeline = createTelemetryPipeline({
      retention: { maxBytes: 1 },
      decodedHistory: { maxEntries: 1 },
    });
    try {
      await pipeline.ingestPayload({ body: body("old"), deliveryId: "old" });
      const observations: {
        envelopeCount: number;
        old?: string;
        newest?: string;
      }[] = [];
      pipeline.subscribe((snapshot, change) => {
        if (change.type !== "ingest") return;
        observations.push({
          envelopeCount: snapshot.envelopes.length,
          old: pipeline.getDecodedPayload("old")?.body.toString(),
          newest: pipeline.getDecodedPayload("newest")?.body.toString(),
        });
      });
      const result = await pipeline.ingestPayload({
        body: payload,
        deliveryId: "newest",
      });
      expect(result).toMatchObject({
        status,
        retained: false,
        envelopeId: "newest",
      });
      if (status === "ignored")
        expect(result).toMatchObject({ reason: "unsupported_items" });
      expect(observations).toEqual([
        { envelopeCount: 0, old: undefined, newest: payload },
      ]);
      expect(pipeline.getDecodedPayload("newest")?.body.toString()).toBe(
        payload,
      );
    } finally {
      pipeline.dispose();
    }
  },
);
