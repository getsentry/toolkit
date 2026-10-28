import { expect, test, vi } from "vitest";
import { createTelemetryPipeline } from "./node.ts";

function body(eventId: string): string {
  return `{}\n{"type":"event"}\n${JSON.stringify({ event_id: eventId, timestamp: 1 })}`;
}

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
