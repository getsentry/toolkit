import type { TraceItemAttribute } from "../../../api-client";
import { normalizeEventsDataset } from "../../../utils/events-datasets";
import {
  BASE_COMMON_FIELDS,
  DATASET_FIELDS,
  RECOMMENDED_FIELDS,
} from "../search-events/config";
import type { AttributeMatches } from "./agent";
import type { SearchAttributesDataset } from "./search";

const DATASET_LABELS: Record<
  SearchAttributesDataset,
  { title: string; associatedTool: string }
> = {
  spans: {
    title: "Span Attributes",
    associatedTool: "search_traces",
  },
  logs: {
    title: "Log Attributes",
    associatedTool: "search_logs",
  },
  metrics: {
    title: "Metric Attributes",
    associatedTool: "search_metrics",
  },
};

const MAX_DESCRIPTION_LENGTH = 255;

interface QuerySettings {
  organizationSlug: string;
  dataset: SearchAttributesDataset;
  period: string;
}

export function formatListResult({
  organizationSlug,
  dataset,
  period,
  attributes,
  limit,
  notes = [],
  importantInfo = [],
}: QuerySettings & {
  attributes: TraceItemAttribute[];
  limit: number;
  notes?: string[];
  importantInfo?: string[];
}): string {
  const labels = DATASET_LABELS[dataset];
  const lines: string[] = [];

  lines.push(...importantInfo);
  lines.push(
    `# ${labels.title} in **${organizationSlug}** (last ${period})`,
    "",
  );
  if (attributes.length === 0) {
    return formatNoneSeen(lines, labels.title.toLowerCase(), period);
  }

  lines.push(
    "**Suggested presentation:** A table works well here, with each attribute's type, description, deprecation status, replacement attributes, and whether it's added by Sentry.",
    "",
    "Please tell the user each attribute's type, description, examples, whether they were added by sentry, and which attributes are deprecated and what replaces them.",
    "",
  );

  const sorted = sortAttributes(attributes, dataset);
  const shown = sorted.slice(0, limit);

  lines.push(...formatAttributeTable(shown), "", "## Response Notes", "");
  if (shown.length < sorted.length) {
    lines.push(`- Showing ${shown.length} of ${sorted.length}.`);
  }
  lines.push(
    `- There is no pagination. Input a \`query\` to narrow down your search.`,
    `- Use a key with \`${labels.associatedTool}\` to query its values.`,
    ...notes.map((note) => `- ${note}`),
  );
  return lines.join("\n");
}

export function formatFindResult({
  organizationSlug,
  dataset,
  period,
  query,
  matches,
  totalAttributes,
}: QuerySettings & {
  query: string;
  matches: AttributeMatches;
  totalAttributes: number;
}): string {
  const labels = DATASET_LABELS[dataset];
  const lines = [
    `# ${labels.title} Matching "${query}" in **${organizationSlug}** (last ${period})`,
    "",
  ];
  if (totalAttributes === 0)
    return formatNoneSeen(lines, labels.title.toLowerCase(), period);

  const { best, candidates } = matches;
  if (!best && candidates.length === 0) {
    lines.push(
      // No count: the shortlist may have searched only part of what was seen.
      `None of the ${labels.title.toLowerCase()} searched match this query.`,
      "",
      "## Response Notes",
      "",
      "- Try another `query`, or omit `query` to list every attribute.",
    );
    return lines.join("\n");
  }

  if (best) lines.push(...formatBestMatch(best), "");
  if (candidates.length > 0) {
    lines.push(
      best ? "## Other Candidates" : "## Possible Matches",
      "",
      ...formatAttributeTable(candidates),
      "",
    );
  }
  lines.push(
    "## Response Notes",
    "",
    `- Use a key with \`${labels.associatedTool}\` to query its values.`,
  );
  return lines.join("\n");
}

function formatBestMatch({
  key,
  type,
  secondaryAliases,
  context,
  attributeSource,
}: TraceItemAttribute): string[] {
  const lines = [`## Best Match: \`${key}\``, "", `**Type**: ${type}`];
  if (attributeSource.source_type === "sentry") {
    lines.push("**Added by Sentry**");
  }
  const brief = flatten(context?.brief);
  if (brief) lines.push(`**Description**: ${brief}`);
  if (context?.examples?.length) {
    lines.push(`**Examples**: ${context.examples.join(", ")}`);
  }
  if (secondaryAliases?.length) {
    lines.push(
      `**Aliases**: ${secondaryAliases.map((alias) => `\`${alias}\``).join(", ")}`,
    );
  }
  if (context?.isDeprecated) {
    lines.push(
      context.replacementAttribute
        ? `**Deprecated**: use \`${context.replacementAttribute}\` instead`
        : "**Deprecated**",
    );
  }
  return lines;
}

function formatNoneSeen(lines: string[], noun: string, period: string): string {
  lines.push(
    `No ${noun} were seen in the last ${period}.`,
    "",
    "## Response Notes",
    "",
    "- Try a longer `period` or a different `dataset`.",
  );
  return lines.join("\n");
}

function formatAttributeTable(attributes: TraceItemAttribute[]): string[] {
  return [
    "| Attribute | Type | Description | Added by Sentry | Deprecated | Replacement Attribute |",
    "| --- | --- | --- | --- | --- | --- |",
    ...attributes.map(
      (attribute) =>
        `| \`${escapeCell(attribute.key)}\` | ${attribute.type} | ${escapeCell(describeCell(attribute))} | ${attribute.attributeSource.source_type === "sentry" ? "yes" : ""} | ${attribute.context?.isDeprecated ? "yes" : ""} | ${escapeCell(attribute.context?.replacementAttribute ?? "")} |`,
    ),
  ];
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

/** Blank when there's no description */
function describeCell({ context }: TraceItemAttribute): string {
  const brief = flatten(context?.brief);
  if (brief) {
    const examples = flatten(
      `EXAMPLE VALUES: ${context?.examples?.join(", ")}`,
    );
    return truncate(
      `${brief} ${context?.examples ? examples : ""}`,
      MAX_DESCRIPTION_LENGTH,
    );
  } else return "";
}

export function flatten(text: string | undefined): string {
  return text?.replace(/\s+/g, " ").trim() ?? "";
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength
    ? text
    : `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function escapeCell(text: string): string {
  return text.replaceAll("|", "\\|");
}
