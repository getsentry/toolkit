import type { TraceItemAttribute } from "../../../api-client";
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

const MAX_DESCRIPTION_LENGTH = 120;

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

  if (importantInfo) {
    importantInfo.map((info) => lines.push(info));
  }

  lines.push(
    `# ${labels.title} in **${organizationSlug}** (last ${period})`,
    "",
  );
  if (attributes.length === 0) {
    return formatNoneSeen(lines, labels.title.toLowerCase(), period);
  }

  // Sort by key so related attributes (http.*, db.*) stay together.
  const sorted = [...attributes].sort((a, b) => a.key.localeCompare(b.key));
  const shown = sorted.slice(0, limit);

  lines.push(...formatAttributeTable(shown), "", "## Response Notes", "");
  if (shown.length < sorted.length) {
    lines.push(
      `- Showing ${shown.length} of ${sorted.length}. Pass a \`query\` to find specific attributes.`,
    );
  }
  lines.push(
    `- Use a key with \`${labels.associatedTool}\` to query its values.`,
    ...notes.map((note) => `- ${note}`),
  );
  return lines.join("\n");
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

/** Blank when there's no description */
function describeCell({ context }: TraceItemAttribute): string {
  const brief = flatten(context?.brief);
  if (brief) {
    return truncate(brief, MAX_DESCRIPTION_LENGTH);
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
