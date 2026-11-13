import { inlineCode } from "@sentry/toolkit-core/markdown";
import { z } from "zod";
import {
  type ToolSession,
  formatToolCall,
  getToolCallRoute,
} from "./tool-helpers/tool-call-formatting";
import type { SuggestedActionValue } from "./tool-helpers/suggested-actions";

/**
 * Side quests are optional detours a tool response points out, such as a
 * setup problem that would make future data easier to read. They are not
 * needed for the current task; `suggestedActions` covers that.
 *
 * A tool runs its detectors with `buildSideQuests`. Each detector returns one
 * quest or null, and the array order is the rank. See
 * docs/contributing/tool-responses.md#side-quests.
 */
export interface SideQuest {
  /** Stable snake_case handle, such as `js_source_maps`. */
  id: string;
  /** The problem and its fix, in one or two sentences. */
  tip: string;
  /** Calls that start the fix, named as the target tool. */
  next?: SideQuestCall[];
  /** A docs.sentry.io page for the fix. */
  docs?: string;
  /** One line per cause, when causes differ by file. */
  details?: string[];
}

interface SideQuestCall {
  tool: string;
  args: Record<string, SuggestedActionValue>;
}

export interface SideQuestCandidate extends SideQuest {
  /** Lower comes first; ties keep detector order. */
  rank: number;
}

export type SideQuestDetector<Input> = (
  input: Input,
) => SideQuestCandidate | null;

const MAX_SIDE_QUESTS = 3;
const MAX_NEXT = 2;
export const MAX_DETAILS = 3;

export const sideQuestsSchema = z
  .array(
    z.object({
      id: z.string(),
      tip: z.string(),
      next: z
        .array(
          z.object({
            tool: z.string(),
            args: z.record(z.string(), z.unknown()),
          }),
        )
        .optional(),
      docs: z.string().optional(),
      details: z.array(z.string()).optional(),
    }),
  )
  .optional()
  .describe(
    "Optional setup fixes, most useful first. Not needed for the current task.",
  );

/**
 * Runs the detectors and returns their quests ranked and capped, keeping only
 * `next` calls the session can make and dropping empty fields. Returns
 * undefined when there are none, so the response omits the key.
 */
export function buildSideQuests<Input>(
  input: Input,
  detectors: readonly SideQuestDetector<Input>[],
  session: ToolSession,
  max = MAX_SIDE_QUESTS,
): SideQuest[] | undefined {
  const quests = detectors
    .flatMap((detect) => {
      const candidate = detect(input);
      return candidate ? [candidate] : [];
    })
    // Array.prototype.sort is stable, so ties keep detector order
    .sort((a, b) => a.rank - b.rank)
    .slice(0, max)
    .map(({ id, tip, next, docs, details }) => {
      const calls = (next ?? [])
        .filter(({ tool }) => getToolCallRoute(tool, session) !== null)
        .slice(0, MAX_NEXT);
      const lines = (details ?? []).slice(0, MAX_DETAILS);
      return {
        id,
        tip,
        ...(calls.length > 0 && { next: calls }),
        ...(docs && { docs }),
        ...(lines.length > 0 && { details: lines }),
      };
    });
  return quests.length > 0 ? quests : undefined;
}

/** The `## Concerns Identified` markdown section, or an empty string. */
export function formatSideQuests(quests: SideQuest[] | undefined): string {
  if (!quests) {
    return "";
  }
  let output =
    "## Concerns Identified\n\nOptional; not needed for the current task.\n\n";
  // tips and details are built from constants and quote upstream values with
  // inlineCode, so they need no escaping here
  for (const { tip, next, docs, details } of quests) {
    const calls = next?.length
      ? ` Next: ${next.map(({ tool, args }) => inlineCode(formatToolCall({ toolName: tool, arguments: args }))).join(", ")}.`
      : "";
    output += `- ${tip}${calls}${docs ? ` Docs: ${docs}` : ""}\n`;
    for (const line of details ?? []) {
      output += `  - ${line}\n`;
    }
  }
  return `${output}\n`;
}
