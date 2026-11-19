import type { z } from "zod";
import type { FrameInterface } from "../api-client";

export type Frame = z.infer<typeof FrameInterface>;

export type CodeLocation = {
  repository?: string | undefined;
  path?: string | undefined;
  line?: number;
  url: string;
};

/** Formats a verified source location for the issue-details response. */
export function formatCodeLocation(codeLocation: CodeLocation): string {
  const output = ["## Code Location", ""];
  if (codeLocation.repository) {
    output.push(`**Repository**: ${codeLocation.repository}`);
  }
  if (codeLocation.path) {
    output.push(`**Path**: ${codeLocation.path}`);
  }
  if (codeLocation.line !== undefined) {
    output.push(`**Line**: ${codeLocation.line}`);
  }
  output.push(`**Source**: ${codeLocation.url}`, "");
  return `${output.join("\n")}\n`;
}

/** Selects Sentry's most relevant application frame: the last in-app frame. */
export function findMostRelevantInAppFrame(frames: Frame[]): Frame | undefined {
  return frames.findLast((frame) => frame.inApp === true);
}
