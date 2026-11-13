import { z } from "zod";
import type { TraceItemAttribute } from "../../../api-client";
import { callEmbeddedAgent } from "../../../internal/agents/callEmbeddedAgent";
import type { SearchAttributesDataset } from "./search";
import { keyHintsSystemPrompt, shortlistSystemPrompt } from "./config";
import { flatten } from "./format";

const MAX_KEY_HINTS = 5;
const MIN_KEY_HINT_LENGTH = 3;

export const keyHintsAgentOutputSchema = z.object({
  hints: z
    .array(z.string())
    .describe("Parts of key names to search for, most likely first"),
});

type KeyHintsAgentOutput = z.output<typeof keyHintsAgentOutputSchema>;

/**
 * Turn a plain-English or partial-key query into parts of key names to search
 * the attributes endpoint with. The agent calls no tools.
 */
export async function generateKeyHintsAgent({
  query,
  dataset,
}: {
  query: string;
  dataset: SearchAttributesDataset;
}): Promise<string[]> {
  const { result } = await callEmbeddedAgent<KeyHintsAgentOutput>({
    system: keyHintsSystemPrompt,
    prompt: `Dataset: ${dataset}\nQuestion: ${query}`,
    tools: {},
    schema: keyHintsAgentOutputSchema,
  });
  return cleanKeyHints(result.hints);
}

/**
 * Each hint costs a request, and a short one can match most keys, so the
 * prompt's limits are enforced here too.
 */
export function cleanKeyHints(hints: string[]): string[] {
  const kept = hints
    .map((hint) => hint.trim())
    .filter((hint) => hint.length >= MIN_KEY_HINT_LENGTH);
  return [...new Set(kept)].slice(0, MAX_KEY_HINTS);
}

export const shortlistAttributesAgentOutputSchema = z.object({
  best: z
    .string()
    .nullable()
    .describe(
      "The one key that clearly answers the question, or null when no single key clearly wins",
    ),
  candidates: z
    .array(z.string())
    .describe(
      "Other plausible keys, most relevant first. Empty when nothing is relevant.",
    ),
});

type ShortlistAttributesAgentOutput = z.output<
  typeof shortlistAttributesAgentOutputSchema
>;

/** What find mode shows: an optional best match, then the other candidates in order. */
export interface AttributeMatches {
  best?: TraceItemAttribute;
  candidates: TraceItemAttribute[];
}

export interface ShortlistAttributesAgentOptions {
  query: string;
  dataset: SearchAttributesDataset;
  attributes: TraceItemAttribute[];
  limit: number;
}

/**
 * Shortlist the attribute keys that match a plain-English or partial-key query.
 * The agent gets the fetched attributes in its prompt and calls no tools.
 */
export async function shortlistAttributesAgent(
  options: ShortlistAttributesAgentOptions,
): Promise<AttributeMatches> {
  const { result } = await callEmbeddedAgent<ShortlistAttributesAgentOutput>({
    system: shortlistSystemPrompt,
    prompt: buildShortlistPrompt(options),
    tools: {},
    schema: shortlistAttributesAgentOutputSchema,
  });
  return toAttributeMatches(result, options.attributes, options.limit);
}

export function buildShortlistPrompt({
  query,
  dataset,
  attributes,
  limit,
}: ShortlistAttributesAgentOptions): string {
  return [
    `Dataset: ${dataset}`,
    `Question: ${query}`,
    `Return at most ${limit} keys in total, counting best.`,
    "",
    "Attributes:",
    ...attributes.map(formatAttributeLine),
  ].join("\n");
}

/** Leaves out whatever is unknown, so a key with no description is just its key and type. */
function formatAttributeLine(attribute: TraceItemAttribute): string {
  const { key, type, secondaryAliases, context } = attribute;
  const details: string[] = [];
  if (context?.brief) details.push(context.brief);
  if (context?.examples?.length) {
    details.push(`Examples: ${context.examples.join(", ")}.`);
  }
  if (secondaryAliases?.length) {
    details.push(`Aliases: ${secondaryAliases.join(", ")}.`);
  }
  if (context?.isDeprecated) {
    details.push(
      context.replacementAttribute
        ? `Deprecated, replaced by ${context.replacementAttribute}.`
        : "Deprecated.",
    );
  }

  const trivialAttributeData = `- ${key} (${type})`;
  return details.length > 0
    ? `${trivialAttributeData}: ${flatten(details.join(" "))}`
    : trivialAttributeData;
}

/**
 * Map the agent's keys back to fetched attributes. Drops keys that weren't
 * fetched (invented or altered by the model) and repeats, then applies the limit.
 */
export function toAttributeMatches(
  result: ShortlistAttributesAgentOutput,
  attributes: TraceItemAttribute[],
  limit: number,
): AttributeMatches {
  const byKey = new Map(
    attributes.map((attribute) => [attribute.key, attribute]),
  );
  const best = result.best ? byKey.get(result.best) : undefined;
  const seen = new Set(best ? [best.key] : []);
  const candidates: TraceItemAttribute[] = [];
  for (const key of result.candidates) {
    const attribute = byKey.get(key);
    if (!attribute || seen.has(key)) continue;
    seen.add(key);
    candidates.push(attribute);
  }
  return { best, candidates: candidates.slice(0, best ? limit - 1 : limit) };
}
