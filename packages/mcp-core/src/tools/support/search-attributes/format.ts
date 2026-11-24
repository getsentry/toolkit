import { z } from "zod";
import type { TraceItemAttribute } from "../../../api-client";
import { normalizeEventsDataset } from "../../../utils/events-datasets";
import {
  BASE_COMMON_FIELDS,
  DATASET_FIELDS,
  RECOMMENDED_FIELDS,
} from "../search-events/config";
import type { AttributeMatches } from "./agent";
import {
  SEARCH_ATTRIBUTES_DATASETS,
  type SearchAttributesDataset,
} from "./config";

const DATASET_LABELS: Record<
  SearchAttributesDataset,
  { noun: string; associatedTool: string }
> = {
  spans: { noun: "span attributes", associatedTool: "search_traces" },
  logs: { noun: "log attributes", associatedTool: "search_logs" },
  metrics: { noun: "metric attributes", associatedTool: "search_metrics" },
};

const attributeOutputSchema = z.object({
  key: z
    .string()
    .describe(
      "The exact key to use with search_traces, search_logs, or search_metrics.",
    ),
  type: z.enum(["string", "number", "boolean", "array"]),
  addedBySentry: z.boolean(),
  description: z.string().nullable(),
  examples: z.array(z.union([z.string(), z.number(), z.boolean()])),
  aliases: z.array(z.string()),
  deprecated: z.boolean(),
  replacementKey: z
    .string()
    .nullable()
    .describe("The key that replaces this one, when it's deprecated."),
});

export const searchAttributesOutputSchema = z.object({
  dataset: z.enum(SEARCH_ATTRIBUTES_DATASETS),
  period: z.string(),
  query: z.string().nullable(),
  resultType: z
    .enum(["list", "matches"])
    .describe(
      "list: the dataset's attributes. matches: the attributes that answer query.",
    ),
  best: attributeOutputSchema
    .nullable()
    .describe("With matches, the one key that clearly answers query, if any."),
  attributes: z
    .array(attributeOutputSchema)
    .describe(
      "With list, the attributes shown. With matches, the other candidates, most relevant first.",
    ),
  totalAttributes: z
    .number()
    .int()
    .describe("How many attributes this result was picked from, before limit."),
  presentationHint: z
    .string()
    .nullable()
    .describe("How best to present this data."),
  notes: z.array(z.string()),
});

export type SearchAttributesOutput = z.output<
  typeof searchAttributesOutputSchema
>;

type AttributeOutput = z.output<typeof attributeOutputSchema>;

interface ResultSettings {
  dataset: SearchAttributesDataset;
  period: string;
}

/**
 * The dataset's attributes, recommended keys first. Also the fallback when the
 * AI can't match `query`, with `fallbackNote` saying why.
 */
export function buildListResult({
  dataset,
  period,
  query,
  attributes,
  limit,
  fallbackNote,
}: ResultSettings & {
  query: string | null;
  attributes: TraceItemAttribute[];
  limit: number;
  fallbackNote?: string | undefined;
}): SearchAttributesOutput {
  const { noun, associatedTool } = DATASET_LABELS[dataset];
  const shown = sortAttributes(attributes, dataset).slice(0, limit);
  const notes = fallbackNote ? [fallbackNote] : [];
  if (attributes.length === 0) {
    notes.push(...noneSeenNotes(noun, period));
  } else {
    notes.push(
      "There is no pagination. Input a `query` to narrow down your search.",
      `Use a key with \`${associatedTool}\` to query its values.`,
    );
  }
  return {
    dataset,
    period,
    query,
    resultType: "list",
    best: null,
    attributes: shown.map(toAttributeOutput),
    totalAttributes: attributes.length,
    presentationHint:
      shown.length > 0
        ? "A table works well here, with each attribute's type, description, examples, whether it's added by Sentry, and, for deprecated attributes, what replaces them."
        : null,
    notes,
  };
}

/** The shortlist for `query`: an optional best match, then the other candidates. */
export function buildFindResult({
  dataset,
  period,
  query,
  matches,
  totalAttributes,
}: ResultSettings & {
  query: string;
  matches: AttributeMatches;
  totalAttributes: number;
}): SearchAttributesOutput {
  const { noun, associatedTool } = DATASET_LABELS[dataset];
  const { best, candidates } = matches;
  let notes: string[];
  if (totalAttributes === 0) {
    notes = noneSeenNotes(noun, period);
  } else if (!best && candidates.length === 0) {
    notes = [
      `None of the ${noun} searched match this query.`,
      "Try another `query`, or omit `query` to list every attribute.",
    ];
  } else {
    notes = [`Use a key with \`${associatedTool}\` to query its values.`];
  }
  return {
    dataset,
    period,
    query,
    resultType: "matches",
    best: best ? toAttributeOutput(best) : null,
    attributes: candidates.map(toAttributeOutput),
    totalAttributes,
    presentationHint: best
      ? "Separate the best result from the rest of the candidates for clarity."
      : "Use a table to display all the information given about the candidates.",
    notes,
  };
}

function noneSeenNotes(noun: string, period: string): string[] {
  return [
    `No ${noun} were seen in the last ${period}.`,
    "Try a longer `period` or a different `dataset`.",
  ];
}

function toAttributeOutput({
  key,
  type,
  attributeSource,
  secondaryAliases,
  context,
}: TraceItemAttribute): AttributeOutput {
  const description = flatten(context?.brief);
  return {
    key,
    type,
    addedBySentry: attributeSource.source_type === "sentry",
    description: description,
    examples: context?.examples ?? [],
    aliases: secondaryAliases ?? [],
    deprecated: context?.isDeprecated ?? false,
    replacementKey: context?.replacementAttribute ?? null,
  };
}

/**
 * Search events' recommended fields first, then the rest. Both sort by key so
 * related attributes (http.*, db.*) stay together.
 */
function sortAttributes(
  attributes: TraceItemAttribute[],
  dataset: SearchAttributesDataset,
): TraceItemAttribute[] {
  const recommended = getRecommendedKeysByDataset(dataset);
  const group = ({ key }: TraceItemAttribute) => (recommended.has(key) ? 0 : 1);
  return [...attributes].sort(
    (a, b) => group(a) - group(b) || a.key.localeCompare(b.key),
  );
}

export function getRecommendedKeysByDataset(dataset: SearchAttributesDataset) {
  return new Set([
    ...RECOMMENDED_FIELDS[normalizeEventsDataset(dataset)].basic,
    ...Object.keys(DATASET_FIELDS[normalizeEventsDataset(dataset)]),
    ...Object.keys(BASE_COMMON_FIELDS),
  ]);
}

export function flatten(text: string | undefined): string {
  return text?.replace(/\s+/g, " ").trim() ?? "";
}
