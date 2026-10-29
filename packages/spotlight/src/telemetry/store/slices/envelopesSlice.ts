import { stringifyValue } from "../../utils/stringifyValue.ts";
import type { Envelope } from "@sentry/core";
import type { StateCreator } from "zustand/vanilla";
import {
  ATTACHMENT_EVENT_TYPES,
  RAW_TYPES,
  SUPPORTED_EVENT_TYPES,
} from "../../constants/sentry.ts";
import type { ProcessingRuntime } from "../../internal/types.ts";
import type { EventAttachment, Sdk, SentryEvent } from "../../types.ts";
import { sdkToPlatform } from "../../utils/sdkToPlatform.ts";
import { generateUuidv4 } from "../../uuid.ts";
import type {
  EnvelopesSliceActions,
  EnvelopesSliceState,
  SentryStore,
} from "../types.ts";
import { normalizeSpanItem } from "../utils/spanProcessor.ts";

export const createEnvelopesSlice =
  (
    runtime: ProcessingRuntime,
  ): StateCreator<
    SentryStore,
    [],
    [],
    EnvelopesSliceState & EnvelopesSliceActions
  > =>
  (set, get) => {
    const processing = new Map<string, Promise<void>[]>();
    const generatedIds = new WeakMap<Envelope, string>();
    function process(envelope: Envelope) {
      const generation = runtime.generation;
      const pending: Promise<void>[] = [];
      const envelopeId = stringifyValue(
        envelope[0].__spotlight_envelope_id ??
          generatedIds.get(envelope) ??
          generateUuidv4(),
      );
      generatedIds.set(envelope, envelopeId);
      if (get().envelopes.has(envelopeId))
        return {
          count: get().envelopes.size,
          pending: processing.get(envelopeId) ?? [],
        };
      processing.set(envelopeId, pending);
      function finish(count: number) {
        void Promise.allSettled(pending).then(() => {
          if (processing.get(envelopeId) === pending)
            processing.delete(envelopeId);
        });
        return { count, pending };
      }
      const [header, items] = envelope;
      const sentAt = new Date(header.sent_at as string).getTime();
      const lastSeen = Number.isFinite(sentAt) ? sentAt : runtime.receivedAtMs;
      // Read the inferred source type from the envelope header (set by server)
      const sourceType = (
        header as {
          __spotlight_inferred_source?: "browser" | "server" | "mobile";
        }
      ).__spotlight_inferred_source;
      let sdk: Sdk;

      if (header.sdk?.name && header.sdk.version) {
        sdk = {
          name: header.sdk.name,
          version: header.sdk.version,
          lastSeen: lastSeen,
        };
      } else if (items.length > 0) {
        sdk = get().inferSdkFromEvent(items[0][1] as SentryEvent);
        sdk.lastSeen = lastSeen;
      } else {
        sdk = {
          name: "unknown",
          version: "0.0.0",
          lastSeen,
        };
      }

      get().storeSdkRecord(sdk);
      if (runtime.generation !== generation)
        return finish(get().envelopes.size);

      const traceContext = header.trace;

      const attachmentsByEventId = new Map<string, EventAttachment[]>();
      const envelopeScopedAttachments: EventAttachment[] = [];
      let eventCount = 0;

      for (const [itemHeader, itemData] of items) {
        if (SUPPORTED_EVENT_TYPES.has(itemHeader.type)) {
          eventCount += 1;
        }

        if (!ATTACHMENT_EVENT_TYPES.has(itemHeader.type)) {
          continue;
        }

        const rawData = (itemData as { data?: unknown })?.data;
        if (typeof rawData !== "string") {
          continue;
        }

        const attachment: EventAttachment = {
          header: itemHeader,
          data: rawData,
        };

        const eventId =
          "event_id" in itemHeader
            ? (itemHeader.event_id as string | undefined)
            : undefined;

        if (eventId) {
          const existing = attachmentsByEventId.get(eventId) ?? [];
          existing.push(attachment);
          attachmentsByEventId.set(eventId, existing);
        } else {
          envelopeScopedAttachments.push(attachment);
        }
      }

      for (const [itemIndex, [itemHeader, itemData]] of items.entries()) {
        if (runtime.generation !== generation) break;
        if (itemHeader.type === "span") {
          for (const event of normalizeSpanItem(itemData, sdk)) {
            if (runtime.generation !== generation) break;
            event.platform = sdkToPlatform(sdk.name);
            if (sourceType) event.__sourceType = sourceType;
            pending.push(get().pushEvent(event));
          }
          continue;
        }
        if (SUPPORTED_EVENT_TYPES.has(itemHeader.type)) {
          const item = structuredClone(itemData) as SentryEvent;
          item.type ??= itemHeader.type as SentryEvent["type"];
          if (
            !RAW_TYPES.has(itemHeader.type) &&
            (typeof item.platform !== "string" || !item.platform.trim())
          ) {
            item.platform = sdkToPlatform(sdk.name);
          }
          if (traceContext) {
            if (!item.contexts) {
              item.contexts = {};
            }
            item.contexts.trace ??= traceContext;
          }
          // Attach the inferred source type to the event for UI display
          if (sourceType) {
            (item as { __sourceType?: typeof sourceType }).__sourceType =
              sourceType;
          }
          const eventId =
            item.event_id ??
            ("event_id" in itemHeader
              ? (itemHeader.event_id as string | undefined)
              : undefined);
          item.event_id = eventId ?? `${envelopeId}:${itemIndex}`;
          let attachmentsForEvent = eventId
            ? attachmentsByEventId.get(eventId)
            : undefined;

          if (
            !attachmentsForEvent?.length &&
            eventCount === 1 &&
            envelopeScopedAttachments.length > 0
          ) {
            attachmentsForEvent = envelopeScopedAttachments;
          }

          if (attachmentsForEvent?.length) {
            item.attachments = attachmentsForEvent;
          }
          pending.push(get().pushEvent(item));
        }
      }

      const { envelopes } = get();
      if (runtime.generation !== generation) return finish(envelopes.size);
      const newEnvelopes = new Map(envelopes);
      newEnvelopes.set(envelopeId, envelope);
      set({ envelopes: newEnvelopes });
      return finish(newEnvelopes.size);
    }
    return {
      envelopes: new Map(),
      ingestEnvelope: async (envelope) => {
        const { count, pending } = process(envelope);
        const results = await Promise.allSettled(pending);
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
        return count;
      },
      getEnvelopes: () => Array.from(get().envelopes.values()),
    };
  };
