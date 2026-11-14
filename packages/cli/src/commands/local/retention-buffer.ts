/** Raw receiver retention, indexed by delivery ID independently of decoding. */
import { uuidv7 } from "uuidv7";
import { logger } from "../../lib/logger.js";
import {
  prepareReceiverEnvelope,
  withReceiverBarrier,
  type ReceiverEnvelope,
  type ReceiverBuffer,
} from "./receiver-ingest.js";
import { textParser } from "../../lib/completion-target.js";
import { ValidationError } from "../../lib/errors.js";
import {
  DEFAULT_MAX_ENVELOPES,
  isValidMaxEnvelopes,
  MAX_ENVELOPES,
} from "./retention-limits.js";

type Subscriber = {
  callback: Parameters<ReceiverBuffer["subscribe"]>[0];
  position: number;
  scheduled?: NodeJS.Immediate | undefined;
};
type RetainedEnvelope = {
  item: ReceiverEnvelope;
  arrivedAt: number;
  position: number;
};
export type RetentionSettings = {
  maxEnvelopes: number;
  retainedEnvelopes: number;
};
export type LocalRetentionBuffer = {
  buffer: ReceiverBuffer;
  getSettings: () => RetentionSettings;
  resize: (maxEnvelopes: number) => Promise<void>;
  subscribeSettings: (
    listener: (settings: RetentionSettings) => void,
  ) => () => void;
};
export class RetentionLimitError extends Error {
  readonly status: 400 | 409;

  constructor(message: string, status: 400 | 409 = 400) {
    super(message);
    this.name = "RetentionLimitError";
    this.status = status;
  }
}
export function validateMaxEnvelopes(value: unknown): asserts value is number {
  if (!isValidMaxEnvelopes(value))
    throw new RetentionLimitError(
      `Retention limit must be an integer between 1 and ${MAX_ENVELOPES}.`,
    );
}
const limitFlag = {
  kind: "parsed",
  brief: "Maximum envelopes retained by this receiver or session",
  parse: textParser((value: string): number => {
    const parsed = /^\d+$/.test(value) ? Number(value) : NaN;
    if (!isValidMaxEnvelopes(parsed))
      throw new ValidationError(
        `Retention limit must be an integer between 1 and ${MAX_ENVELOPES}.`,
        "max-envelopes",
      );
    return parsed;
  }),
} as const;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hasStackFilename(payload: unknown, filename: string): boolean {
  const values = record(record(payload)["exception"])["values"];
  return (
    Array.isArray(values) &&
    values.some((value) => {
      const frames = record(record(value)["stacktrace"])["frames"];
      return (
        Array.isArray(frames) &&
        frames.some((frame) => {
          const candidate = record(frame)["filename"];
          return typeof candidate === "string" && candidate.endsWith(filename);
        })
      );
    })
  );
}
export const MAX_ENVELOPES_FLAG = {
  ...limitFlag,
  default: String(DEFAULT_MAX_ENVELOPES),
} as const;
export const OPTIONAL_MAX_ENVELOPES_FLAG = {
  ...limitFlag,
  optional: true,
} as const;

export function createLocalRetentionBuffer(
  maxEnvelopes = DEFAULT_MAX_ENVELOPES,
): LocalRetentionBuffer {
  validateMaxEnvelopes(maxEnvelopes);
  const subscribers = new Map<string, Subscriber>();
  const entries = new Map<string, RetainedEnvelope>();
  let newest: RetainedEnvelope | undefined;
  let position = 0;
  const listeners = new Set<(settings: RetentionSettings) => void>();
  const getSettings = (): RetentionSettings => ({
    maxEnvelopes,
    retainedEnvelopes: entries.size,
  });
  const clear = () => {
    entries.clear();
    newest = undefined;
  };
  const buffer: ReceiverBuffer = {
    put(item) {
      const id = prepareReceiverEnvelope(item);
      if (entries.has(id)) return;
      // Replay pending subscription history before any entry can be evicted.
      for (const readerId of subscribers.keys()) buffer.stream(readerId);
      newest = { item, arrivedAt: Date.now(), position: ++position };
      entries.set(id, newest);
      if (entries.size > maxEnvelopes) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      for (const readerId of subscribers.keys()) buffer.stream(readerId);
    },
    read(filters = { timeWindow: 60 }) {
      const candidates =
        "envelopeId" in filters
          ? [entries.get(filters.envelopeId ?? "")].filter(
              (entry) => entry !== undefined,
            )
          : [...entries.values()].reverse();
      return candidates
        .filter((entry) => {
          if (
            "timeWindow" in filters &&
            filters.timeWindow !== undefined &&
            entry.arrivedAt <= Date.now() - filters.timeWindow * 1000
          )
            return false;
          if ("filename" in filters && filters.filename) {
            const filename = filters.filename;
            return (
              entry.item
                .getParsedEnvelope()
                ?.envelope[1].some(([, payload]) => {
                  return hasStackFilename(payload, filename);
                }) ?? false
            );
          }
          return true;
        })
        .map((entry) => entry.item);
    },
    subscribe(callback, lastEventId) {
      const id = uuidv7();
      const subscriber: Subscriber = {
        callback,
        position: entries.get(lastEventId ?? "")?.position ?? 0,
      };
      subscribers.set(id, subscriber);
      subscriber.scheduled = setImmediate(() => buffer.stream(id));
      subscriber.scheduled.unref();
      return id;
    },
    unsubscribe(id) {
      const subscriber = subscribers.get(id);
      if (subscriber?.scheduled) clearImmediate(subscriber.scheduled);
      subscribers.delete(id);
    },
    stream(id) {
      const subscriber = subscribers.get(id);
      if (!subscriber) return;
      if (subscriber.scheduled) {
        clearImmediate(subscriber.scheduled);
        subscriber.scheduled = undefined;
      }
      if (subscriber.position >= position) return;
      const deliver = (entry: RetainedEnvelope) => {
        if (entry.position <= subscriber.position) return;
        subscriber.position = entry.position;
        try {
          subscriber.callback(entry.item);
        } catch (error) {
          logger.debug("Local receiver subscriber failed", error);
        }
      };
      // Live readers need only the new entry, regardless of retention capacity.
      if (newest?.position === subscriber.position + 1) {
        deliver(newest);
      } else {
        for (const entry of entries.values()) deliver(entry);
      }
    },
    clear,
    reset: clear,
  };
  return {
    buffer,
    getSettings,
    resize(nextLimit) {
      validateMaxEnvelopes(nextLimit);
      return withReceiverBarrier(buffer, () => {
        if (nextLimit < entries.size)
          throw new RetentionLimitError(
            `Cannot lower the limit below ${entries.size} retained envelopes. Clear envelopes first.`,
            409,
          );
        if (nextLimit === maxEnvelopes) return;
        maxEnvelopes = nextLimit;
        for (const listener of listeners) listener(getSettings());
      });
    },
    subscribeSettings(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
