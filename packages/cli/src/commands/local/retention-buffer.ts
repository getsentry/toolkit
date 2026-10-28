/** Receiver retention controls backed by the shared telemetry pipeline. */
import {
  createLocalTelemetryBuffer,
  type LocalTelemetryBuffer,
} from "./telemetry-buffer.js";
import { ValidationError } from "../../lib/errors.js";
import {
  DEFAULT_MAX_ENVELOPES,
  isValidMaxEnvelopes,
  MAX_ENVELOPES,
} from "./retention-limits.js";

export type RetentionSettings = {
  maxEnvelopes: number;
  retainedEnvelopes: number;
};
export type LocalRetentionBuffer = {
  buffer: LocalTelemetryBuffer;
  getSettings: () => RetentionSettings;
  resize: (maxEnvelopes: number) => Promise<void>;
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
  const buffer = createLocalTelemetryBuffer(maxEnvelopes);
  const listeners = new Set<(settings: RetentionSettings) => void>();
  const getSettings = (): RetentionSettings => ({
    maxEnvelopes,
    retainedEnvelopes: buffer.read({ all: true }).length,
  });
  return {
    buffer,
    getSettings,
    resize(nextLimit) {
      validateMaxEnvelopes(nextLimit);
      return buffer.withWriteBarrier(async () => {
        const retained = buffer.read({ all: true });
        if (nextLimit < retained.length)
          throw new RetentionLimitError(
            `Cannot lower the limit below ${retained.length} retained envelopes. Clear envelopes first.`,
            409,
          );
        if (nextLimit === maxEnvelopes) return;
        await buffer.pipeline.setRetention({ maxEnvelopes: nextLimit });
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
