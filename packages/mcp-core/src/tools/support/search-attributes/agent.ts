import { z } from "zod";
import type { TraceItemAttribute } from "../../../api-client";
import { callEmbeddedAgent } from "../../../internal/agents/callEmbeddedAgent";
import { describeField } from "../search-events/utils";
import { systemPrompt } from "./config";
import type { SearchAttributesDataset } from "./search";
import { lookupOtelSemantics } from "../../../internal/agents/tools/otel-semantics";

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
  const { result } = await callEmbeddedAgent<
    ShortlistAttributesAgentOutput,
    typeof shortlistAttributesAgentOutputSchema
  >({
    system: systemPrompt,
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

function formatAttributeLine(attribute: TraceItemAttribute): string {
  const { key, type, secondaryAliases, context } = attribute;
  let line = `- ${key} (${type}): ${describeField(attribute)}`;
  if (secondaryAliases?.length) {
    line += ` Aliases: ${secondaryAliases.join(", ")}.`;
  }
  if (context?.isDeprecated) {
    line += context.replacementAttribute
      ? ` Deprecated, replaced by ${context.replacementAttribute}.`
      : " Deprecated.";
  }

  if (context?.examples) {
    line += `Examples: ${context.examples.join(",")}.`;
  }
  return line;
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
