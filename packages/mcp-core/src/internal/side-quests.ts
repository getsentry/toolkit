import { getActiveSpan, metrics } from "@sentry/core";
import { inlineCode } from "@sentry/toolkit-core/markdown";
import { z } from "zod";
import {
  type ToolSession,
  formatToolCall,
  getToolCallRoute,
} from "./tool-helpers/tool-call-formatting";
import type { SuggestedActionValue } from "./tool-helpers/suggested-actions";
import { CONSTRAINT_PARAMETER_KEYS } from "../types";

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
  details?: string[] | undefined;
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
    "Optional setup fixes and follow-ups, most useful first. Not needed for the current task.",
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
  const ranked = detectors
    .flatMap((detect) => {
      const candidate = detect(input);
      return candidate ? [candidate] : [];
    })
    // Array.prototype.sort is stable, so ties keep detector order
    .sort((a, b) => a.rank - b.rank);
  recordSideQuests(
    ranked.map(({ id }) => id),
    max,
  );
  const quests = ranked
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
  recordOfferedCalls(quests);
  return quests.length > 0 ? quests : undefined;
}

/** The span attribute every tool call records its fingerprint in. */
export const TOOL_CALL_FINGERPRINT_ATTRIBUTE = "app.tool_call.fingerprint";

/**
 * A short, stable id for a tool call: the tool name and its arguments in key
 * order, hashed. A shown quest records the fingerprints of its `next` calls,
 * and every tool call records its own, so analytics can tell when a later
 * call from the same user is one a quest offered.
 *
 * Scope keys (organization, project, region) are left out: the server fills
 * them from constraints or the default organization, so an agent may or may
 * not pass them. Empty values are left out for the same reason.
 */
export function fingerprintToolCall(
  tool: string,
  args: Record<string, unknown>,
): string {
  const entries = Object.entries(args)
    .filter(
      ([key, value]) =>
        !CONSTRAINT_PARAMETER_KEYS.has(key) && value != null && value !== "",
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return fnv1a(JSON.stringify([tool, entries]));
}

/** 32-bit FNV-1a as 8 hex characters. Not for security; only stability matters. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Records the `next` calls each shown quest offered as
 * `app.side_quest.<id>.next`, a comma-separated list of fingerprints. A later
 * span from the same user whose {@link TOOL_CALL_FINGERPRINT_ATTRIBUTE} is in
 * that list is a call the quest offered.
 */
function recordOfferedCalls(quests: SideQuest[]) {
  const attributes: Record<string, string> = {};
  for (const { id, next } of quests) {
    if (next?.length) {
      attributes[`app.side_quest.${id}.next`] = next
        .map(({ tool, args }) => fingerprintToolCall(tool, args))
        .join(",");
    }
  }
  if (Object.keys(attributes).length > 0) {
    getActiveSpan()?.setAttributes(attributes);
  }
}

/**
 * Records which quests were detected and which the cap cut, so analytics can
 * query them without parsing tool output: one `app.side_quest.<id>` span
 * attribute per detected quest, the counts, and a metric per shown quest,
 * which trace sampling does not drop. Quest ids are part of this contract.
 */
function recordSideQuests(ids: string[], max: number) {
  const shown = ids.slice(0, max);
  const attributes: Record<string, string | number> = {
    "app.side_quests.detected": ids.length,
    "app.side_quests.shown": shown.length,
  };
  ids.forEach((id, index) => {
    attributes[`app.side_quest.${id}`] = index < max ? "shown" : "capped";
  });
  getActiveSpan()?.setAttributes(attributes);
  for (const id of shown) {
    metrics.count("app.side_quest.shown", 1, {
      attributes: { "side_quest.id": id },
    });
  }
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
