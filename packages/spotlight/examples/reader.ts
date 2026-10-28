import {
  type TelemetryReader,
  serializeSnapshot,
  serializeSummaries,
  serializeTrace,
} from "@sentry/spotlight";

/** Business logic only needs a reader, independent of how telemetry arrives. */
export function inspectTrace(reader: TelemetryReader, traceId: string) {
  const trace = reader.getTrace(traceId);
  return {
    queries: reader.getDatabaseQuerySummaries({
      traceId,
      order: "desc",
      limit: 10,
    }),
    detailedQueries: reader.getDatabaseQuerySummaries({
      traceId,
      includeSpans: true,
    }),
    traceJson: trace ? JSON.stringify(serializeTrace(trace)) : undefined,
    snapshotJson: JSON.stringify(serializeSnapshot(reader.getSnapshot())),
    profileJson: JSON.stringify(
      serializeSummaries(reader.getProfileFunctionSummaries({ traceId })),
    ),
  };
}

/** Keep the filters unchanged across pages; restart after any snapshot change. */
export function readEventIds(reader: TelemetryReader) {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = reader.readPage("events", { limit: 1, order: "asc", cursor });
    if (page.status === "invalid") return page; // stale_cursor, invalid_cursor, or invalid_query
    ids.push(...page.items.map((event) => event.event_id));
    cursor = page.nextCursor;
  } while (cursor);
  return { status: "ok" as const, ids };
}
