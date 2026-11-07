import type { z } from "zod";
import type { FrameInterface } from "../api-client";

export type Frame = z.infer<typeof FrameInterface>;

export type CodeLocation = {
  repository?: string;
  path?: string;
  line?: number;
  url: string;
};

/** Selects Sentry's most relevant application frame: the last in-app frame. */
export function findMostRelevantInAppFrame(frames: Frame[]): Frame | undefined {
  return frames.findLast((frame) => frame.inApp === true);
}
