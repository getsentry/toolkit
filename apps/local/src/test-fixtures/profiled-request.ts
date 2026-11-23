import { decodeEnvelope } from "@/lib/spotlight.ts";

/** sentry-python request with a continuous profile split over two chunks. */
export function profiledRequest() {
  const decode = (id: string, type: string, payload: unknown) =>
    decodeEnvelope(JSON.stringify([{}, [[{ type }, payload]]]), id)[0]!;
  const chunk = (id: string, samples: number[]) =>
    decode(id, "profile_chunk", {
      chunk_id: id,
      profiler_id: "p",
      profile: {
        active_thread_id: "main",
        frames: [{ function: "work", in_app: true }],
        stacks: [[0]],
        samples: samples.map((timestamp) => ({
          thread_id: "main",
          stack_id: 0,
          timestamp,
        })),
      },
    });
  return [
    decode("event", "transaction", {
      event_id: "e",
      transaction: "GET /slow",
      start_timestamp: 1,
      timestamp: 1.1,
      contexts: {
        trace: { trace_id: "t", span_id: "root" },
        profile: { profiler_id: "p" },
      },
      spans: [
        {
          span_id: "db",
          parent_span_id: "root",
          op: "db.query",
          description: "SELECT 1",
          start_timestamp: 1.04,
          timestamp: 1.06,
        },
      ],
    }),
    chunk("chunk-1", [1.01, 1.03]),
    chunk("chunk-2", [1.07, 1.09, 1.12]),
  ];
}
