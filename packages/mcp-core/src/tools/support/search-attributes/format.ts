import type { TraceItemAttribute } from "../../../api-client";
import { normalizeEventsDataset } from "../../../utils/events-datasets";
import {
  BASE_COMMON_FIELDS,
  DATASET_FIELDS,
  RECOMMENDED_FIELDS,
} from "../search-events/config";
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

export function* formatListResult({
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
}) {
  const labels = DATASET_LABELS[dataset];

  yield* importantInfo;
  yield `# ${labels.title} in **${organizationSlug}** (last ${period})`;
  yield "";

  if (attributes.length === 0) {
    yield* formatNoneSeen(labels.title.toLowerCase(), period);
    return;
  }

  yield "**Suggested presentation:** A table works well here, with each attribute's type, description, deprecation status, replacement attributes, and whether it's added by Sentry.";
  yield "";
  yield "Please tell the user each attribute's type, description, examples, whether they were added by sentry, and which attributes are deprecated and what replaces them.";
  yield "";

  const sorted = sortAttributes(attributes, dataset);
  const shown = sorted.slice(0, limit);

  yield* formatAttributeTable(shown);
  yield "";
  yield "## Response Notes";
  yield "";
  if (shown.length < sorted.length) {
    yield `- Showing ${shown.length} of ${sorted.length}.`;
  }
  yield `- Use a key with \`${labels.associatedTool}\` to query its values.`;
  for (const note of notes) {
    yield `- ${note}`;
  }
}

/**
 * Search events' recommended fields first, then the rest. Both sort by key so
 * related attributes (http.*, db.*) stay together.
 */
function sortAttributes(
  attributes: TraceItemAttribute[],
  dataset: SearchAttributesDataset,
): TraceItemAttribute[] {
  const recommended = new Set([
    ...RECOMMENDED_FIELDS[normalizeEventsDataset(dataset)].basic,
    ...Object.keys(DATASET_FIELDS[normalizeEventsDataset(dataset)]),
    ...Object.keys(BASE_COMMON_FIELDS),
  ]);
  const group = ({ key }: TraceItemAttribute) => (recommended.has(key) ? 0 : 1);
  return [...attributes].sort(
    (a, b) => group(a) - group(b) || a.key.localeCompare(b.key),
  );
}

function* formatNoneSeen(noun: string, period: string) {
  yield `No ${noun} were seen in the last ${period}.`;
  yield "";
  yield "## Response Notes";
  yield "";
  yield "- Try a longer `period` or a different `dataset`.";
}

function* formatAttributeTable(attributes: TraceItemAttribute[]) {
  yield "| Attribute | Type | Description | Added by Sentry | Deprecated | Replacement Attribute |";
  yield "| --- | --- | --- | --- | --- | --- |";
  for (const attribute of attributes) {
    yield `| \`${escapeCell(attribute.key)}\` | ${attribute.type} | ${escapeCell(describeCell(attribute))} | ${attribute.attributeSource.source_type === "sentry" ? "yes" : ""} | ${attribute.context?.isDeprecated ? "yes" : ""} | ${escapeCell(attribute.context?.replacementAttribute ?? "")} |`;
  }
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

function flatten(text: string | undefined): string {
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
