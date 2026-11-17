import { z } from "zod";
import type { SentryApiService } from "../../../api-client";
import { formatToolCallInstruction } from "../../../internal/tool-helpers/tool-call-formatting";
import {
  type SnapshotImageEntry,
  type SnapshotVcsInfo,
  snapshotDiffPercent,
} from "./formatting";
import {
  groupSnapshotImages,
  snapshotGroupsOf,
  snapshotImageEntries,
  snapshotImageGroupsSchema,
  snapshotImageSchema,
  snapshotString,
  snapshotVcsSchema,
  toSnapshotImage,
  toSnapshotImageGroups,
  toSnapshotVcs,
} from "./structured";

interface SnapshotDiffPair {
  base_image?: SnapshotImageEntry;
  head_image?: SnapshotImageEntry;
  diff?: number | null;
}

export const getSnapshotOutputSchema = z.object({
  organizationSlug: z.string(),
  snapshotId: z.string(),
  url: z.string(),
  comparisonType: z.string().nullable(),
  state: z.string().nullable(),
  projectId: z.string().nullable(),
  counts: z.object({
    total: z.number(),
    changed: z.number(),
    added: z.number(),
    removed: z.number(),
    renamed: z.number(),
    unchanged: z.number(),
    errored: z.number(),
    skipped: z.number(),
  }),
  vcs: snapshotVcsSchema.nullable(),
  approval: z
    .object({
      status: z.string().nullable(),
      autoApproved: z.boolean(),
    })
    .nullable(),
  changed: snapshotGroupsOf(
    snapshotImageSchema.extend({ diffPercent: z.number().nullable() }),
  ),
  added: snapshotImageGroupsSchema,
  removed: snapshotImageGroupsSchema,
  renamed: snapshotGroupsOf(
    snapshotImageSchema.extend({ previous: snapshotImageSchema.nullable() }),
  ),
  errored: snapshotImageGroupsSchema,
  images: snapshotImageGroupsSchema
    .optional()
    .describe("Snapshot image inventory, present only when nothing changed."),
  unchanged: snapshotImageGroupsSchema
    .optional()
    .describe("Present only when showUnmodified=true."),
  skipped: snapshotImageGroupsSchema
    .optional()
    .describe("Present only when showUnmodified=true."),
  responseNotes: z.array(z.string()),
});

type SnapshotSummary = z.infer<typeof getSnapshotOutputSchema>;

function countField(
  data: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = data[key];
  return typeof value === "number" ? value : fallback;
}

function asObjects<T extends object>(value: unknown): T[] {
  return snapshotImageEntries(value) as T[];
}

function pairImage(
  entry: SnapshotDiffPair | SnapshotImageEntry,
): SnapshotImageEntry {
  if ("head_image" in entry || "base_image" in entry) {
    const pair = entry as SnapshotDiffPair;
    return pair.head_image ?? pair.base_image ?? {};
  }
  return entry as SnapshotImageEntry;
}

function diffPercent(diff: number | null | undefined): number | null {
  return typeof diff === "number" && Number.isFinite(diff)
    ? snapshotDiffPercent(diff)
    : null;
}

export async function getSnapshotSummary(
  apiService: SentryApiService,
  organizationSlug: string,
  snapshotId: string,
  {
    showUnmodified,
    ...instructionContext
  }: {
    showUnmodified: boolean;
    experimentalMode: boolean;
    availableToolNames?: ReadonlySet<string>;
    directToolNames?: ReadonlySet<string>;
  },
): Promise<SnapshotSummary> {
  const data = (await apiService.getSnapshotDetails({
    organizationSlug,
    snapshotId,
    compactMetadata: true,
  })) as Record<string, unknown>;

  const allImages = asObjects<SnapshotImageEntry>(data.images);
  const changed = asObjects<SnapshotDiffPair>(data.changed);
  const renamed = asObjects<SnapshotDiffPair>(data.renamed);
  const added = asObjects<SnapshotImageEntry>(data.added);
  const removed = asObjects<SnapshotImageEntry>(data.removed);
  const errored = asObjects<SnapshotDiffPair>(data.errored);
  const unchanged = asObjects<SnapshotDiffPair | SnapshotImageEntry>(
    data.unchanged,
  );
  const skipped = asObjects<SnapshotDiffPair | SnapshotImageEntry>(
    data.skipped,
  );

  const counts = {
    total: countField(data, "total_count", allImages.length),
    changed: countField(data, "changed_count", changed.length),
    added: countField(data, "added_count", added.length),
    removed: countField(data, "removed_count", removed.length),
    renamed: countField(data, "renamed_count", renamed.length),
    unchanged: countField(data, "unchanged_count", unchanged.length),
    errored: countField(data, "errored_count", errored.length),
    skipped: countField(data, "skipped_count", skipped.length),
  };

  const url = apiService.getPreprodSnapshotUrl(organizationSlug, snapshotId);
  const comparisonType = snapshotString(data.comparison_type) ?? null;
  const approvalInfo = data.approval_info as
    | { status?: unknown; is_auto_approved?: unknown }
    | null
    | undefined;

  const hasDiffs =
    changed.length > 0 ||
    renamed.length > 0 ||
    added.length > 0 ||
    removed.length > 0 ||
    errored.length > 0;
  const includeUnmodified = showUnmodified && comparisonType !== "solo";

  const responseNotes: string[] = [];
  if (
    !hasDiffs &&
    allImages.length === 0 &&
    !showUnmodified &&
    (counts.unchanged > 0 || counts.skipped > 0)
  ) {
    responseNotes.push(
      "No changed images are shown in compact mode. Re-run `get_snapshot` with `showUnmodified=true` to list unchanged and skipped images.",
    );
  }
  const imageArguments = {
    organizationSlug,
    snapshotId,
    imageIdentifier: "<imageFileName>",
  };
  responseNotes.push(
    formatToolCallInstruction({
      toolName: "get_snapshot_image",
      arguments: imageArguments,
      showArguments: true,
      ...instructionContext,
      purpose:
        "to view one image preview; pass its imageFileName as imageIdentifier.",
      fallbackInstruction: `Use the Sentry tool \`get_sentry_resource(url="${url}?selectedSnapshot=<URL-encoded imageFileName>")\` to view one image preview.`,
    }),
    formatToolCallInstruction({
      toolName: "get_snapshot_image",
      arguments: { ...imageArguments, imageResolution: "full" },
      showArguments: true,
      ...instructionContext,
      fallbackInstruction:
        "Full-resolution snapshot image bytes are not available in this session",
      purpose: "to fetch original full-resolution image bytes",
    }),
  );

  return {
    organizationSlug,
    snapshotId,
    url,
    comparisonType,
    state: snapshotString(data.state) ?? null,
    projectId: snapshotString(data.project_id) ?? null,
    counts,
    vcs: toSnapshotVcs(data.vcs_info as SnapshotVcsInfo | undefined),
    approval:
      approvalInfo && typeof approvalInfo === "object"
        ? {
            status: snapshotString(approvalInfo.status) ?? null,
            autoApproved: approvalInfo.is_auto_approved === true,
          }
        : null,
    changed: groupSnapshotImages(
      [...changed].sort(
        (left, right) => (right.diff ?? -1) - (left.diff ?? -1),
      ),
      pairImage,
      (pair) => ({
        ...toSnapshotImage(pairImage(pair)),
        diffPercent: diffPercent(pair.diff),
      }),
    ),
    added: toSnapshotImageGroups(added),
    removed: toSnapshotImageGroups(removed),
    renamed: groupSnapshotImages(renamed, pairImage, (pair) => ({
      ...toSnapshotImage(pairImage(pair)),
      previous: pair.base_image ? toSnapshotImage(pair.base_image) : null,
    })),
    errored: toSnapshotImageGroups(errored.map(pairImage)),
    ...(hasDiffs ? {} : { images: toSnapshotImageGroups(allImages) }),
    ...(includeUnmodified
      ? {
          unchanged: toSnapshotImageGroups(unchanged.map(pairImage)),
          skipped: toSnapshotImageGroups(skipped.map(pairImage)),
        }
      : {}),
    responseNotes,
  };
}
