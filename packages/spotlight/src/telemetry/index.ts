import { stringifyValue } from "./utils/stringifyValue.ts";
import type { Envelope } from "@sentry/core";
import { SUPPORTED_EVENT_TYPES } from "./constants/sentry.ts";
import type {
  ChangeMetadata,
  Diagnostic,
  DiagnosticCode,
  IgnoreReason,
  IngestCounts,
  IngestOptions,
  IngestResult,
} from "./contracts.ts";
import { createEngine } from "./internal/engine.ts";
import {
  normalizeEnvelope,
  supportsEnvelope,
  validateEnvelope,
} from "./internal/envelopes.ts";
import { readonlyCopy } from "./internal/readonly.ts";
import { createEnvelopeChanges } from "./internal/types.ts";
import {
  diagnostic as makeDiagnostic,
  receipt,
  reportDiagnostic,
} from "./internal/results.ts";
import { validateRetention } from "./internal/retention.ts";
import type {
  TelemetrySnapshot,
  TelemetryStore,
  TelemetryStoreOptions,
} from "./public.ts";
import { createTelemetryReader } from "./reader.ts";
import { normalizeSpanItem } from "./store/utils/spanProcessor.ts";
import type { SentryErrorEvent } from "./types.ts";
import { generateUuidv4 } from "./uuid.ts";

type RetainedEnvelope = {
  id: string;
  envelope: Envelope;
  receivedAtMs: number;
  bytes: number;
  changes: Pick<
    ReturnType<typeof createEnvelopeChanges>,
    | "eventIds"
    | "logIds"
    | "traceIds"
    | "hasProfiles"
    | "sdk"
    | "insertedEvents"
    | "insertedLogs"
    | "insertedTraces"
  >;
};
type InsertionOrder = Pick<
  ReturnType<typeof createEnvelopeChanges>,
  "insertedEvents" | "insertedLogs" | "insertedTraces"
>;

function insertionOrder(changes: InsertionOrder): InsertionOrder {
  return {
    insertedEvents: changes.insertedEvents,
    insertedLogs: changes.insertedLogs,
    insertedTraces: changes.insertedTraces,
  };
}

function clearProcessingScratch(
  changes: ReturnType<typeof createEnvelopeChanges>,
) {
  changes.beforeSpans.clear();
  changes.mutableTraces.clear();
  changes.errorCommit = Promise.resolve();
}

const MiB = 1024 * 1024;
function positive(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

/** Portable processing with bounded work, immutable committed reads and explicit receipts. */
export function createTelemetryStore(
  options: TelemetryStoreOptions = {},
): TelemetryStore {
  const retention = validateRetention(options.retention ?? {});
  let maxEnvelopes = retention.maxEnvelopes ?? 500;
  let maxBytes = retention.maxBytes ?? 64 * MiB;
  const maxPending = positive(options.maxPending ?? 64, "maxPending");
  const maxEnvelopeBytes = positive(
    options.maxEnvelopeBytes ?? 32 * MiB,
    "maxEnvelopeBytes",
  );
  const enrichmentTimeoutMs = positive(
    options.enrichmentTimeoutMs ?? 5000,
    "enrichmentTimeoutMs",
  );
  let maxAgeMs = retention.maxAgeMs;
  let generation = 0;
  let disposed = false;
  let revision = 0;
  let pending = 0;
  let queue: Promise<unknown> = Promise.resolve();
  let pruning: Promise<void> | undefined;
  let journal: RetainedEnvelope[] = [];
  const dependencyCounts = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lifetime = new AbortController();
  const identities = new WeakMap<object, string>();
  const listeners = new Set<
    (snapshot: TelemetrySnapshot, change: ChangeMetadata) => void
  >();
  let enrichmentCache = new Map<
    string,
    { envelopeId: string; exception: SentryErrorEvent["exception"] }
  >();
  let currentDiagnostics: Diagnostic[] = [];
  const stableCopies = new WeakMap<object, unknown>();
  function active(epoch: number) {
    return !disposed && epoch === generation;
  }
  function diagnostic(
    code: DiagnosticCode,
    message: string,
    details: Partial<Omit<Diagnostic, "code" | "message">> = {},
  ) {
    const item = makeDiagnostic(code, message, details);
    currentDiagnostics.push(item);
    reportDiagnostic(options.onDiagnostic, item);
    return item;
  }
  function invalid(
    code: DiagnosticCode,
    message: string,
    diagnostics?: readonly Diagnostic[],
  ): IngestResult {
    const items = diagnostics ?? [makeDiagnostic(code, message)];
    for (const item of items) reportDiagnostic(options.onDiagnostic, item);
    return receipt({ status: "invalid", diagnostics: items }, { revision });
  }
  function ignored(
    reason: IgnoreReason,
    envelopeId?: string,
    retained = false,
  ): IngestResult {
    return receipt(
      {
        status: "ignored",
        reason,
        ...(envelopeId !== undefined ? { envelopeId } : {}),
      },
      { revision, retained },
    );
  }
  function makeEngine() {
    const cache = enrichmentCache;
    const epoch = generation;
    const lifetimeSignal = lifetime.signal;
    let currentEnvelopeId = "";
    let currentSignal: AbortSignal | undefined;
    const created = createEngine({
      enrichStacktrace: async (event) => {
        const envelopeId = currentEnvelopeId;
        const inputSignal = currentSignal;
        const cached = cache.get(event.event_id);
        if (cached?.envelopeId === envelopeId) {
          event.exception = structuredClone(cached.exception);
          return;
        }
        if (options.enrichStacktrace) {
          // A user hook receives an isolated copy. After timeout/abort, late writes cannot escape.
          const enriched = structuredClone(event);
          const controller = new AbortController();
          let timeout: ReturnType<typeof setTimeout> | undefined;
          let completed = false;
          let abortListener!: () => void;
          let lifetimeListener!: () => void;
          try {
            await new Promise<void>((resolve) => {
              const finish = () => {
                if (!completed) {
                  completed = true;
                  resolve();
                }
              };
              const cancel = () => {
                controller.abort();
                finish();
              };
              abortListener = cancel;
              lifetimeListener = cancel;
              inputSignal?.addEventListener("abort", abortListener, {
                once: true,
              });
              lifetimeSignal.addEventListener("abort", lifetimeListener, {
                once: true,
              });
              if (inputSignal?.aborted || lifetimeSignal.aborted) {
                cancel();
                return;
              }
              const deadline = Date.now() + enrichmentTimeoutMs;
              const checkDeadline = () => {
                if (completed) return;
                const remaining = deadline - Date.now();
                if (remaining > 0) {
                  timeout = setTimeout(
                    checkDeadline,
                    Math.min(2147483647, remaining),
                  );
                  return;
                }
                if (active(epoch))
                  diagnostic(
                    "enrichment_timeout",
                    "Stacktrace enrichment exceeded its deadline; telemetry was retained.",
                    { severity: "warning" },
                  );
                cancel();
              };
              checkDeadline();
              void Promise.resolve()
                .then(() =>
                  options.enrichStacktrace!(enriched, {
                    signal: controller.signal,
                  }),
                )
                .then(
                  () => {
                    if (
                      !completed &&
                      active(epoch) &&
                      created.runtime.generation === 0 &&
                      !controller.signal.aborted
                    )
                      event.exception = structuredClone(enriched.exception);
                    finish();
                  },
                  () => {
                    if (!completed && active(epoch))
                      diagnostic(
                        "enrichment_failed",
                        "Stacktrace enrichment failed; telemetry was retained.",
                        {
                          severity: "warning",
                        },
                      );
                    finish();
                  },
                );
            });
          } finally {
            if (timeout !== undefined) clearTimeout(timeout);
            inputSignal?.removeEventListener("abort", abortListener);
            lifetimeSignal.removeEventListener("abort", lifetimeListener);
          }
        }
        if (
          active(epoch) &&
          created.runtime.generation === 0 &&
          !inputSignal?.aborted
        )
          cache.set(event.event_id, {
            envelopeId,
            exception: structuredClone(event.exception),
          });
      },
    });
    return {
      ...created,
      ingestEnvelope(
        envelope: Envelope,
        receivedAtMs: number,
        signal?: AbortSignal,
      ) {
        currentEnvelopeId = stringifyValue(envelope[0].__spotlight_envelope_id);
        currentSignal = signal;
        created.runtime.receivedAtMs = receivedAtMs;
        created.runtime.changes = createEnvelopeChanges();
        return created.store.getState().ingestEnvelope(envelope);
      },
    };
  }
  let engine = makeEngine();
  function stable<T extends object>(value: T): T {
    if (!stableCopies.has(value)) readonlyCopy(value, stableCopies);
    return stableCopies.get(value) as T;
  }
  function stateSnapshot(): TelemetrySnapshot {
    const state = engine.store.getState();
    const committedRevision = revision;
    // Capture committed Maps, whose entries and trace graphs use copy-on-write.
    // Delivery-only listeners need no history copies; browser reads materialize
    // each category once and reuse frozen graphs for untouched records.
    let envelopes: TelemetrySnapshot["envelopes"] | undefined;
    let events: TelemetrySnapshot["events"] | undefined;
    let traces: TelemetrySnapshot["traces"] | undefined;
    let logs: TelemetrySnapshot["logs"] | undefined;
    let sdks: TelemetrySnapshot["sdks"] | undefined;
    let profiles: TelemetrySnapshot["profiles"] | undefined;
    return Object.freeze({
      revision: committedRevision,
      get envelopes() {
        return (envelopes ??= Object.freeze(
          Array.from(state.envelopes.values(), stable),
        ));
      },
      get events() {
        return (events ??= Object.freeze(
          Array.from(state.eventsById.values(), stable),
        ));
      },
      get traces() {
        return (traces ??= Object.freeze(
          Array.from(state.tracesById.values(), stable),
        ));
      },
      get logs() {
        return (logs ??= Object.freeze(
          Array.from(state.logsById.values(), stable),
        ));
      },
      get sdks() {
        return (sdks ??= Object.freeze(
          Array.from(state.sdks.values(), stable),
        ));
      },
      get profiles() {
        return (profiles ??= stable(state.profilesByTraceId));
      },
    });
  }
  let snapshot = stateSnapshot();
  function publish(
    type: ChangeMetadata["type"],
    envelopeIds: readonly string[] = [],
  ) {
    revision++;
    snapshot = stateSnapshot();
    const committed = snapshot;
    const change = Object.freeze({
      type,
      revision,
      envelopeIds: Object.freeze([...envelopeIds]),
    });
    for (const listener of listeners) {
      try {
        listener(committed, change);
      } catch {
        diagnostic(
          "subscriber_failed",
          "A telemetry subscription callback failed.",
          { severity: "warning" },
        );
      }
      if (snapshot !== committed) break;
    }
  }
  function clearTimer() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }
  function scheduleExpiry() {
    clearTimer();
    if (disposed || maxAgeMs === undefined || !journal.length) return;
    const earliest = Math.min(...journal.map((record) => record.receivedAtMs));
    const delay = Math.max(
      1,
      Math.min(2147483647, earliest + maxAgeMs - Date.now()),
    );
    timer = setTimeout(() => {
      timer = undefined;
      void client.prune();
    }, delay);
    if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
  }
  function enqueue<T>(task: (epoch: number) => Promise<T>): Promise<T> {
    const epoch = generation;
    pending++;
    const next = queue
      .then(() => task(epoch))
      .finally(() => {
        if (epoch === generation) pending--;
      });
    queue = next.catch(() => {});
    return next;
  }
  async function rebuild(
    retained: RetainedEnvelope[],
    epoch: number,
    signal?: AbortSignal,
  ) {
    if (!active(epoch) || signal?.aborted) return false;
    const replacement = makeEngine();
    const insertions = new Map<RetainedEnvelope, InsertionOrder>();
    for (const record of retained) {
      if (signal?.aborted) return false;
      await replacement.ingestEnvelope(
        record.envelope,
        record.receivedAtMs,
        signal,
      );
      if (!active(epoch) || signal?.aborted) return false;
      insertions.set(record, insertionOrder(replacement.runtime.changes));
      clearProcessingScratch(replacement.runtime.changes);
    }
    if (!active(epoch) || signal?.aborted) return false;
    engine = replacement;
    for (const [record, changes] of insertions)
      updateInsertions(record, changes);
    const eventIds = engine.store.getState().eventsById;
    for (const key of enrichmentCache.keys())
      if (!eventIds.has(key)) enrichmentCache.delete(key);
    return true;
  }
  function updateInsertions(record: RetainedEnvelope, changes: InsertionOrder) {
    record.changes.insertedEvents = changes.insertedEvents;
    record.changes.insertedLogs = changes.insertedLogs;
    record.changes.insertedTraces = changes.insertedTraces;
  }
  function dependencies(record: RetainedEnvelope) {
    return [
      ...Array.from(record.changes.eventIds, (id) => `event:${id}`),
      ...Array.from(record.changes.traceIds, (id) => `trace:${id}`),
      ...Array.from(record.changes.logIds, (id) => `log:${id}`),
    ];
  }
  function countDependencies(record: RetainedEnvelope, delta: number) {
    for (const key of dependencies(record)) {
      const count = (dependencyCounts.get(key) ?? 0) + delta;
      if (count) dependencyCounts.set(key, count);
      else dependencyCounts.delete(key);
    }
  }
  function restoreJournal(retained: RetainedEnvelope[]) {
    journal = retained;
    dependencyCounts.clear();
    for (const record of retained) countDependencies(record, 1);
  }
  function evictIndependent(
    evicted: RetainedEnvelope[],
    retained: RetainedEnvelope[],
  ): boolean {
    const state = engine.store.getState();
    // Profiles can graft onto another envelope's traces (including future
    // transactions). Keep canonical replay for that dependency graph, and for
    // shared trace/event/log keys so dedup winners are correctly promoted.
    if (
      evicted.some(
        (record) =>
          record.changes.hasProfiles ||
          [...record.changes.traceIds].some((id) =>
            state.profilesByTraceId.has(id),
          ),
      )
    )
      return false;
    const removedCounts = new Map<string, number>();
    for (const record of evicted)
      for (const key of dependencies(record))
        removedCounts.set(key, (removedCounts.get(key) ?? 0) + 1);
    for (const [key, count] of removedCounts)
      if (dependencyCounts.get(key) !== count) return false;
    const envelopes = new Map(state.envelopes);
    const eventsById = new Map(state.eventsById);
    const logsById = new Map(state.logsById);
    const logsByTraceId = new Map(state.logsByTraceId);
    const tracesById = new Map(state.tracesById);
    for (const record of evicted) {
      envelopes.delete(record.id);
      for (const id of record.changes.eventIds) {
        eventsById.delete(id);
        enrichmentCache.delete(id);
      }
      for (const id of record.changes.logIds) logsById.delete(id);
      for (const id of record.changes.traceIds) {
        tracesById.delete(id);
        logsByTraceId.delete(id);
      }
    }
    // SDK order and lastSeen must match replay, even when the first or latest
    // envelope from a source expires. This scans small SDK records, not spans.
    const sdks = new Map<
      string,
      NonNullable<RetainedEnvelope["changes"]["sdk"]>
    >();
    for (const record of retained) {
      const sdk = record.changes.sdk;
      if (sdk) sdks.set(`${sdk.name}@${sdk.version}`, sdk);
    }
    engine.store.setState({
      envelopes,
      eventsById,
      logsById,
      logsByTraceId,
      tracesById,
      sdks,
    });
    return true;
  }
  async function rebuildAffected(
    evicted: RetainedEnvelope[],
    retained: RetainedEnvelope[],
    epoch: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const keys = new Set(evicted.flatMap(dependencies));
    const affected = new Set(evicted);
    // Expand through duplicate IDs and cross-envelope traces/logs. SDK identity
    // is deliberately not a processing dependency shared by every delivery.
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const record of retained) {
        if (affected.has(record)) continue;
        const dependenciesOfRecord = dependencies(record);
        if (!dependenciesOfRecord.some((key) => keys.has(key))) continue;
        affected.add(record);
        for (const key of dependenciesOfRecord) keys.add(key);
        expanded = true;
      }
    }
    const state = engine.store.getState();
    // Keep the full canonical replay for profile dependencies, which also link
    // traces through profiler IDs and profiles received before their traces.
    if (
      [...affected].some(
        (record) =>
          record.changes.hasProfiles ||
          [...record.changes.traceIds].some((id) =>
            state.profilesByTraceId.has(id),
          ),
      )
    )
      return false;
    const replacement = makeEngine();
    const insertions = new Map<RetainedEnvelope, InsertionOrder>();
    for (const record of retained) {
      if (!affected.has(record)) continue;
      if (!active(epoch) || signal?.aborted) return false;
      await replacement.ingestEnvelope(
        record.envelope,
        record.receivedAtMs,
        signal,
      );
      if (!active(epoch) || signal?.aborted) return false;
      insertions.set(record, insertionOrder(replacement.runtime.changes));
      clearProcessingScratch(replacement.runtime.changes);
    }
    // Commit only after replay completes. A cancelled replay cannot mutate the
    // live engine or the provenance used by the next retention operation.
    for (const [record, changes] of insertions)
      updateInsertions(record, changes);
    const rebuilt = replacement.store.getState();
    function merge<T>(
      original: Map<string, T>,
      updates: Map<string, T>,
      prefix: string,
    ) {
      const result = new Map(original);
      for (const key of keys)
        if (key.startsWith(`${prefix}:`))
          result.delete(key.slice(prefix.length + 1));
      for (const [key, value] of updates) result.set(key, value);
      return result;
    }
    function ordered<T>(
      values: Map<string, T>,
      category: "insertedEvents" | "insertedLogs" | "insertedTraces",
    ) {
      const result = new Map<string, T>();
      for (const record of retained)
        for (const id of record.changes[category])
          if (values.has(id)) result.set(id, values.get(id)!);
      return result;
    }
    const eventsById = ordered(
      merge(state.eventsById, rebuilt.eventsById, "event"),
      "insertedEvents",
    );
    const logsById = ordered(
      merge(state.logsById, rebuilt.logsById, "log"),
      "insertedLogs",
    );
    const tracesById = ordered(
      merge(state.tracesById, rebuilt.tracesById, "trace"),
      "insertedTraces",
    );
    const logsByTraceId = merge(
      state.logsByTraceId,
      rebuilt.logsByTraceId,
      "trace",
    );
    const envelopes = new Map(
      retained.map((record) => [record.id, record.envelope]),
    );
    const sdks = new Map<
      string,
      NonNullable<RetainedEnvelope["changes"]["sdk"]>
    >();
    for (const record of retained) {
      const sdk = record.changes.sdk;
      if (sdk) sdks.set(`${sdk.name}@${sdk.version}`, sdk);
    }
    engine.store.setState({
      eventsById,
      logsById,
      tracesById,
      logsByTraceId,
      envelopes,
      sdks,
    });
    for (const record of evicted)
      for (const id of record.changes.eventIds)
        if (!eventsById.has(id)) enrichmentCache.delete(id);
    return true;
  }
  async function enforceRetention(
    epoch: number,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const cutoff =
      maxAgeMs === undefined ? Number.NEGATIVE_INFINITY : Date.now() - maxAgeMs;
    let retained = journal
      .filter((record) => record.receivedAtMs > cutoff)
      .slice(-maxEnvelopes);
    let bytes = retained.reduce((sum, record) => sum + record.bytes, 0);
    let trim = 0;
    while (bytes > maxBytes && trim < retained.length)
      bytes -= retained[trim++].bytes;
    retained = retained.slice(trim);
    if (retained.length === journal.length) return [];
    const keep = new Set(retained.map((record) => record.id));
    const evicted = journal.filter((record) => !keep.has(record.id));
    if (!evictIndependent(evicted, retained)) {
      const applied = await rebuildAffected(evicted, retained, epoch, signal);
      if (!active(epoch) || signal?.aborted) return [];
      if (!applied && !(await rebuild(retained, epoch, signal))) return [];
    }
    if (!active(epoch)) return [];
    for (const record of evicted) countDependencies(record, -1);
    journal = retained;
    return evicted.map((record) => record.id);
  }
  const reader = createTelemetryReader(() => snapshot);
  function ingestOne(
    input: unknown,
    inputOptions: IngestOptions = {},
    withinEpoch?: number,
  ): Promise<IngestResult> {
    const ingestOptions = {
      deliveryId: inputOptions.deliveryId,
      signal: inputOptions.signal,
    };
    if (disposed) return Promise.resolve(ignored("disposed"));
    if (ingestOptions.signal?.aborted)
      return Promise.resolve(ignored("aborted"));
    if (withinEpoch === undefined && pending >= maxPending)
      return Promise.resolve(ignored("queue_full"));
    if (
      ingestOptions.deliveryId !== undefined &&
      (typeof ingestOptions.deliveryId !== "string" ||
        !ingestOptions.deliveryId.trim())
    )
      return Promise.resolve(
        invalid(
          "invalid_delivery_id",
          "deliveryId must be a non-empty string.",
        ),
      );
    if (!validateEnvelope(input))
      return Promise.resolve(
        invalid(
          "invalid_envelope",
          "Expected a parsed envelope [headers, [[itemHeaders, payload], ...]].",
        ),
      );
    const supported = supportsEnvelope(input);
    const inputDiagnostics: Diagnostic[] = [];
    let invalidSpans = 0;
    let candidates = 0;
    let skippedItems = 0;
    for (const [itemIndex, [header, payload]] of input[1].entries()) {
      if (header.type !== "span") {
        if (SUPPORTED_EVENT_TYPES.has(header.type)) candidates++;
        else skippedItems++;
        continue;
      }
      const data = payload as Record<string, unknown>;
      if ("items" in data && data.version !== 2) {
        skippedItems++;
        inputDiagnostics.push(
          makeDiagnostic(
            "unsupported_version",
            "Unsupported span container version was retained without processing.",
            {
              severity: "warning",
              itemIndex,
            },
          ),
        );
        continue;
      }
      const count = Array.isArray(data.items) ? data.items.length : 1;
      const valid = normalizeSpanItem(data, {
        name: "unknown",
        version: "unknown",
        lastSeen: 0,
      }).length;
      candidates += valid;
      invalidSpans += count - valid;
      if (count > valid)
        inputDiagnostics.push(
          makeDiagnostic(
            "invalid_span",
            "Malformed span items were skipped during telemetry processing.",
            {
              severity: "warning",
              itemIndex,
            },
          ),
        );
    }
    skippedItems += invalidSpans;
    let id: string;
    let envelope: Envelope;
    let bytes: number;
    try {
      id =
        ingestOptions.deliveryId ??
        stringifyValue(
          input[0].__spotlight_envelope_id ??
            identities.get(input) ??
            generateUuidv4(),
        );
      identities.set(input, id);
      envelope = normalizeEnvelope(input);
      envelope[0].__spotlight_envelope_id = id;
      bytes = new TextEncoder().encode(JSON.stringify(envelope)).byteLength;
    } catch {
      return Promise.resolve(
        invalid(
          "invalid_envelope",
          "Envelope data must be cloneable wire data.",
        ),
      );
    }
    if (bytes > maxEnvelopeBytes)
      return Promise.resolve(
        invalid(
          "payload_too_large",
          "Parsed envelope exceeds maxEnvelopeBytes.",
        ),
      );
    const receivedAtMs = Date.now();
    const process = async (epoch: number): Promise<IngestResult> => {
      if (!active(epoch)) return ignored(disposed ? "disposed" : "reset", id);
      if (ingestOptions.signal?.aborted) return ignored("aborted", id);
      currentDiagnostics = [];
      for (const item of inputDiagnostics) {
        currentDiagnostics.push(item);
        reportDiagnostic(options.onDiagnostic, item);
      }
      const evicted = await enforceRetention(epoch, ingestOptions.signal);
      if (!active(epoch)) return ignored(disposed ? "disposed" : "reset", id);
      if (ingestOptions.signal?.aborted) {
        if (evicted.length) publish("evict", evicted);
        scheduleExpiry();
        return ignored("aborted", id);
      }
      const retainedBefore = journal;
      const cacheBefore = new Map(enrichmentCache);
      async function rollback() {
        working.store.getState().resetData();
        if (engine !== working) engine.store.getState().resetData();
        restoreJournal(retainedBefore);
        enrichmentCache = new Map(cacheBefore);
        await rebuild(journal, epoch);
        if (active(epoch)) {
          if (evicted.length) publish("evict", evicted);
          scheduleExpiry();
        }
      }
      if (journal.some((record) => record.id === id)) {
        if (evicted.length) publish("evict", evicted);
        scheduleExpiry();
        return ignored("duplicate", id, true);
      }
      const working = engine;
      let failed = false;
      try {
        await working.ingestEnvelope(
          envelope,
          receivedAtMs,
          ingestOptions.signal,
        );
      } catch {
        failed = true;
      }
      if (!active(epoch)) return ignored(disposed ? "disposed" : "reset", id);
      if (failed || ingestOptions.signal?.aborted) {
        await rollback();
        if (!active(epoch)) return ignored(disposed ? "disposed" : "reset", id);
        return ingestOptions.signal?.aborted
          ? ignored("aborted", id)
          : invalid(
              "invalid_envelope",
              "Envelope telemetry could not be processed.",
            );
      }
      const state = working.store.getState();
      const changes = working.runtime.changes;
      const addedEvents = changes.addedEvents;
      let addedSpans = 0;
      for (const [traceId, before] of changes.beforeSpans)
        for (const spanId of state.tracesById.get(traceId)?.spans.keys() ?? [])
          if (!before.has(spanId)) addedSpans++;
      const counts: IngestCounts = {
        events: addedEvents,
        logs: changes.insertedLogs.size,
        spans: addedSpans,
        skippedItems,
        duplicateEvents: Math.max(0, candidates - addedEvents),
      };
      clearProcessingScratch(changes);
      // The span comparison worklist is per-operation scratch space. Retaining
      // it would keep a historical copy of every growing cross-envelope trace.
      const record: RetainedEnvelope = {
        id,
        envelope,
        receivedAtMs,
        bytes,
        changes: {
          eventIds: changes.eventIds,
          logIds: changes.logIds,
          traceIds: changes.traceIds,
          hasProfiles: changes.hasProfiles,
          sdk: changes.sdk,
          insertedEvents: changes.insertedEvents,
          insertedLogs: changes.insertedLogs,
          insertedTraces: changes.insertedTraces,
        },
      };
      journal = [...journal, record];
      countDependencies(record, 1);
      const afterEvicted = await enforceRetention(epoch, ingestOptions.signal);
      if (!active(epoch)) return ignored(disposed ? "disposed" : "reset", id);
      if (ingestOptions.signal?.aborted) {
        await rollback();
        return ignored(
          active(epoch) ? "aborted" : disposed ? "disposed" : "reset",
          id,
        );
      }
      publish("ingest", [id, ...evicted, ...afterEvicted]);
      if (!active(epoch)) return ignored(disposed ? "disposed" : "reset", id);
      scheduleExpiry();
      return receipt(
        supported
          ? {
              status: "processed",
              envelopeId: id,
              diagnostics: currentDiagnostics,
            }
          : {
              status: "ignored",
              reason: "unsupported_items",
              envelopeId: id,
              diagnostics: currentDiagnostics,
            },
        {
          revision,
          retained: journal.some((record) => record.id === id),
          counts,
        },
      );
    };
    return withinEpoch === undefined ? enqueue(process) : process(withinEpoch);
  }
  function queueRetentionPrune(): Promise<void> {
    const epoch = generation;
    const operation = queue.then(async () => {
      if (!active(epoch)) return;
      currentDiagnostics = [];
      const evicted = await enforceRetention(epoch);
      if (active(epoch) && evicted.length) publish("evict", evicted);
      if (active(epoch)) scheduleExpiry();
    });
    queue = operation.catch(() => {});
    return operation;
  }
  const client: TelemetryStore = {
    ...reader,
    ingestEnvelope: (input, inputOptions) => ingestOne(input, inputOptions),
    ingestEnvelopes(inputs, batchOptions = {}) {
      const signal = batchOptions.signal;
      if (disposed || pending >= maxPending) {
        return Promise.resolve(
          Object.freeze(
            Array.from(inputs, () =>
              ignored(disposed ? "disposed" : "queue_full"),
            ),
          ),
        );
      }
      return enqueue(async (epoch) => {
        const results: IngestResult[] = [];
        for (const input of inputs) {
          results.push(
            active(epoch)
              ? await ingestOne(input, { signal }, epoch)
              : ignored(disposed ? "disposed" : "reset"),
          );
        }
        return Object.freeze(results);
      });
    },
    drain: () => queue.then(() => {}),
    getStats: () =>
      Object.freeze({
        pending,
        retainedEnvelopes: journal.length,
        retainedBytes: journal.reduce((sum, item) => sum + item.bytes, 0),
        revision,
        disposed,
      }),
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset() {
      if (disposed) return;
      generation++;
      lifetime.abort();
      lifetime = new AbortController();
      clearTimer();
      engine.store.getState().resetData();
      restoreJournal([]);
      enrichmentCache = new Map();
      engine = makeEngine();
      queue = Promise.resolve();
      pruning = undefined;
      pending = 0;
      publish("reset");
    },
    setRetention(update) {
      if (disposed) return Promise.resolve();
      const next = validateRetention(update);
      if (next.maxEnvelopes !== undefined) maxEnvelopes = next.maxEnvelopes;
      if (next.maxBytes !== undefined) maxBytes = next.maxBytes;
      if (next.maxAgeMs !== undefined) maxAgeMs = next.maxAgeMs;
      // A distinct barrier must cover work submitted after an earlier coalesced prune.
      return queueRetentionPrune();
    },
    prune() {
      if (disposed) return Promise.resolve();
      if (pruning) return pruning;
      // Control work has one coalesced continuation outside ingestion admission.
      // Link it into the same barrier so even invalid/empty work cannot skip expiry.
      const operation = queueRetentionPrune();
      pruning = operation;
      void operation.then(
        () => {
          if (pruning === operation) pruning = undefined;
        },
        () => {
          if (pruning === operation) pruning = undefined;
        },
      );
      return operation;
    },
    dispose() {
      if (disposed) return;
      generation++;
      disposed = true;
      lifetime.abort();
      clearTimer();
      engine.store.getState().resetData();
      journal = [];
      enrichmentCache.clear();
      engine = makeEngine();
      pending = 0;
      publish("dispose");
      listeners.clear();
      pruning = undefined;
      queue = Promise.resolve();
    },
  };
  return client;
}
export type {
  TelemetryStore,
  TelemetryStoreOptions,
  TelemetrySnapshot,
} from "./public.ts";
export type { IngestResult, Diagnostic } from "./contracts.ts";
