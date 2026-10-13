/** Resize through the Spotlight SDK's public API while keeping a stable buffer facade. */
import { createSpotlightBuffer } from "@spotlightjs/spotlight/sdk";
import { ValidationError } from "../../lib/errors.js";
import {
  DEFAULT_MAX_ENVELOPES,
  isValidMaxEnvelopes,
  MAX_ENVELOPES,
} from "./retention-limits.js";

type SpotlightBuffer = ReturnType<typeof createSpotlightBuffer>;
type Subscriber = {
  callback: Parameters<SpotlightBuffer["subscribe"]>[0];
  id: string;
};
export type RetentionSettings = {
  maxEnvelopes: number;
  retainedEnvelopes: number;
};
export type LocalRetentionBuffer = {
  buffer: SpotlightBuffer;
  getSettings: () => RetentionSettings;
  resize: (maxEnvelopes: number) => void;
  subscribeSettings: (
    listener: (settings: RetentionSettings) => void,
  ) => () => void;
};
export class RetentionLimitError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 = 400,
  ) {
    super(message);
    this.name = "RetentionLimitError";
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
  parse(value: string): number {
    const parsed = /^\d+$/.test(value) ? Number(value) : NaN;
    if (!isValidMaxEnvelopes(parsed))
      throw new ValidationError(
        `Retention limit must be an integer between 1 and ${MAX_ENVELOPES}.`,
        "max-envelopes",
      );
    return parsed;
  },
} as const;
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
  let delegate = createSpotlightBuffer(maxEnvelopes);
  const buffer = createSpotlightBuffer(1);
  const subscribers = new Map<string, Subscriber>();
  const arrivalTimes = new WeakMap<object, number>();
  const listeners = new Set<(settings: RetentionSettings) => void>();
  const getSettings = (): RetentionSettings => ({
    maxEnvelopes,
    retainedEnvelopes: delegate.read({ all: true }).length,
  });
  buffer.put = (item) => {
    arrivalTimes.set(item, Date.now());
    delegate.put(item);
  };
  buffer.read = (filters = { timeWindow: 60 }) => {
    if ("timeWindow" in filters && filters.timeWindow !== undefined) {
      const { timeWindow, ...rest } = filters;
      return delegate
        .read({ ...rest, all: true })
        .filter(
          (item) =>
            (arrivalTimes.get(item) ?? 0) > Date.now() - timeWindow * 1000,
        );
    }
    return delegate.read(filters);
  };
  buffer.subscribe = (callback, lastEventId) => {
    const id = delegate.subscribe(callback, lastEventId);
    subscribers.set(id, { callback, id });
    return id;
  };
  buffer.unsubscribe = (id) => {
    const subscriber = subscribers.get(id);
    if (subscriber) delegate.unsubscribe(subscriber.id);
    subscribers.delete(id);
  };
  buffer.stream = (id) => {
    const subscriber = subscribers.get(id);
    if (subscriber) delegate.stream(subscriber.id);
  };
  buffer.clear = () => delegate.clear();
  buffer.reset = () => delegate.reset();
  return {
    buffer,
    getSettings,
    resize(nextLimit) {
      validateMaxEnvelopes(nextLimit);
      const retained = delegate.read({ all: true });
      if (nextLimit < retained.length)
        throw new RetentionLimitError(
          `Cannot lower the limit below ${retained.length} retained envelopes. Clear envelopes first.`,
          409,
        );
      if (nextLimit === maxEnvelopes) return;
      // Flush queued deliveries before moving readers, then advance each new reader
      // past the copied history so an active stream neither misses nor repeats it.
      for (const subscriber of subscribers.values())
        delegate.stream(subscriber.id);
      const next = createSpotlightBuffer(nextLimit);
      for (const item of retained.reverse()) next.put(item);
      const previous = delegate;
      delegate = next;
      for (const subscriber of subscribers.values()) {
        previous.unsubscribe(subscriber.id);
        let replaying = true;
        subscriber.id = next.subscribe((item) => {
          if (!replaying) subscriber.callback(item);
        });
        next.stream(subscriber.id);
        replaying = false;
      }
      maxEnvelopes = nextLimit;
      for (const listener of listeners) listener(getSettings());
    },
    subscribeSettings(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
