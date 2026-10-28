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
};
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
        return created.store.getState().ingestEnvelope(envelope);
      },
    };
  }
  let engine = makeEngine();
  function stable<T extends object>(value: T): T {
    if (!stableCopies.has(value)) stableCopies.set(value, readonlyCopy(value));
    return stableCopies.get(value) as T;
  }
  function stateSnapshot(): TelemetrySnapshot {
    const state = engine.store.getState();
    return Object.freeze({
      revision,
      envelopes: Object.freeze(state.getEnvelopes().map(stable)),
      events: Object.freeze(state.getEvents().map(stable)),
      traces: readonlyCopy(state.getTraces()),
      logs: Object.freeze(state.getLogs().map(stable)),
      sdks: readonlyCopy(state.getSdks()),
      profiles: readonlyCopy(state.profilesByTraceId),
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
    const replacement = makeEngine();
    for (const record of retained) {
      if (signal?.aborted) return false;
      await replacement.ingestEnvelope(
        record.envelope,
        record.receivedAtMs,
        signal,
      );
      if (!active(epoch) || signal?.aborted) return false;
    }
    engine = replacement;
    const eventIds = engine.store.getState().eventsById;
    for (const key of enrichmentCache.keys())
      if (!eventIds.has(key)) enrichmentCache.delete(key);
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
    const evicted = journal
      .filter((record) => !keep.has(record.id))
      .map((record) => record.id);
    if (!(await rebuild(retained, epoch, signal))) return [];
    if (!active(epoch)) return [];
    journal = retained;
    return evicted;
  }
  function spanKeys() {
    const keys = new Set<string>();
    for (const trace of engine.store.getState().tracesById.values())
      for (const id of trace.spans.keys()) keys.add(`${trace.trace_id}:${id}`);
    return keys;
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
    let validSpans = 0;
    let invalidSpans = 0;
    let otherItems = false;
    let candidates = 0;
    let skippedItems = 0;
    for (const [itemIndex, [header, payload]] of input[1].entries()) {
      if (header.type !== "span") {
        otherItems = true;
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
      validSpans += valid;
      candidates += valid;
      invalidSpans += count - valid;
      if (count > valid)
        inputDiagnostics.push(
          makeDiagnostic(
            "invalid_span",
            "Malformed span items were skipped; valid telemetry was retained.",
            {
              severity: "warning",
              itemIndex,
            },
          ),
        );
    }
    if (invalidSpans > 0 && validSpans === 0 && !otherItems)
      return Promise.resolve(
        invalid(
          "invalid_span",
          "Span items are missing valid IDs or timestamps.",
          inputDiagnostics.map((item) =>
            makeDiagnostic(
              item.code,
              "Span items are missing valid IDs or timestamps.",
              {
                severity: "error",
                itemIndex: item.itemIndex,
              },
            ),
          ),
        ),
      );
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
        journal = retainedBefore;
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
      const beforeEvents = new Set(working.store.getState().eventsById.keys());
      const beforeLogs = new Set(working.store.getState().logsById.keys());
      const beforeSpans = spanKeys();
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
      const addedEvents = Array.from(state.eventsById.keys()).filter(
        (key) => !beforeEvents.has(key),
      ).length;
      const counts: IngestCounts = {
        events: addedEvents,
        logs: Array.from(state.logsById.keys()).filter(
          (key) => !beforeLogs.has(key),
        ).length,
        spans: Array.from(spanKeys()).filter((key) => !beforeSpans.has(key))
          .length,
        skippedItems,
        duplicateEvents: Math.max(0, candidates - addedEvents),
      };
      journal = [...journal, { id, envelope, receivedAtMs, bytes }];
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
      journal = [];
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
