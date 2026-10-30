import type {
  ImageContent,
  TextContent,
} from "@modelcontextprotocol/sdk/types.js";
import type { SentryApiService } from "../../../api-client";
import { UserInputError } from "../../../errors";
import {
  type ImagePreviewResult,
  blobToBase64,
  createImagePreview,
} from "../../../internal/blob-utils";
import { formatToolCallInstruction } from "../../../internal/tool-helpers/tool-call-formatting";
import {
  type SnapshotImageEntry,
  type SnapshotImageTreeItem,
  type SnapshotVcsInfo,
  formatSnapshotDiffPercent,
  getSnapshotImageDisplayName,
  renderSnapshotImageContext,
  renderSnapshotImageTreeSection,
} from "./formatting";

interface SnapshotDiffPair {
  base_image?: SnapshotImageEntry;
  head_image?: SnapshotImageEntry;
  diff?: number | null;
}

interface SnapshotImageInfo {
  content_hash?: string;
  display_name?: string | null;
  group?: string | null;
  image_file_name?: string;
  width?: number;
  height?: number;
  description?: string | null;
  image_url?: string;
  context?: unknown;
  [key: string]: unknown;
}

interface SnapshotImageDetailResponse {
  image_file_name?: string;
  comparison_status?:
    | "added"
    | "removed"
    | "changed"
    | "unchanged"
    | "renamed"
    | "errored"
    | "skipped"
    | null;
  head_image?: SnapshotImageInfo | null;
  base_image?: SnapshotImageInfo | null;
  diff_image_url?: string | null;
  diff_percentage?: number | null;
  previous_image_file_name?: string | null;
}

export type SnapshotImageResolution = "preview" | "full";

function fullResolutionHint({
  organizationSlug,
  snapshotId,
  imageIdentifier,
  experimentalMode,
  availableToolNames,
  directToolNames,
}: {
  organizationSlug: string;
  snapshotId: string;
  imageIdentifier: string;
  experimentalMode: boolean;
  availableToolNames?: ReadonlySet<string>;
  directToolNames?: ReadonlySet<string>;
}): string {
  return `- **Full Resolution**: ${formatToolCallInstruction({
    toolName: "get_snapshot_image",
    arguments: {
      organizationSlug,
      snapshotId,
      imageIdentifier,
      imageResolution: "full",
    },
    experimentalMode,
    availableToolNames,
    directToolNames,
    fallbackInstruction:
      "Full-resolution snapshot image bytes are not available in this session",
    purpose: "for full-resolution image bytes",
  })}`;
}

function getSnapshotImagePreviewFallback(snapshotUrl: string): string {
  const separator = snapshotUrl.includes("?") ? "&" : "?";
  return `Use the Sentry tool \`get_sentry_resource(url="${snapshotUrl}${separator}selectedSnapshot=<image_file_name>")\``;
}

function formatSnapshotImageFullResolutionStep({
  organizationSlug,
  snapshotId,
  imageIdentifier,
  experimentalMode,
  availableToolNames,
  directToolNames,
}: {
  organizationSlug: string;
  snapshotId: string;
  imageIdentifier: string;
  experimentalMode: boolean;
  availableToolNames?: ReadonlySet<string>;
  directToolNames?: ReadonlySet<string>;
}): string {
  const instruction = formatToolCallInstruction({
    toolName: "get_snapshot_image",
    arguments: {
      organizationSlug,
      snapshotId,
      imageIdentifier,
      imageResolution: "full",
    },
    experimentalMode,
    availableToolNames,
    directToolNames,
    fallbackInstruction:
      "Full-resolution snapshot image bytes are not available in this session",
    purpose: "to fetch original full-resolution image bytes",
  });
  return `- ${instruction}`;
}

function countField(
  data: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = data[key];
  return typeof value === "number" ? value : fallback;
}

function formatImageMetadata(img: SnapshotImageInfo): string[] {
  const lines: string[] = [];
  if (img.display_name) lines.push(`- **Display Name**: ${img.display_name}`);
  if (img.group) lines.push(`- **Group**: ${img.group}`);
  if (img.image_file_name) lines.push(`- **File**: \`${img.image_file_name}\``);
  if (img.width || img.height)
    lines.push(`- **Dimensions**: ${img.width}×${img.height}`);
  if (img.description) lines.push(`- **Description**: ${img.description}`);
  const contextLines = renderSnapshotImageContext(img.context);
  if (contextLines.length > 0) {
    lines.push("", "### Context", ...contextLines);
  }
  return lines;
}

async function createPreviewOrNull(
  blob: Blob,
  contentType: string,
): Promise<ImagePreviewResult | null> {
  try {
    return await createImagePreview(blob, contentType);
  } catch {
    return null;
  }
}

async function fetchAndAppendImage(
  apiService: SentryApiService,
  imageUrl: string,
  label: string,
  imageResolution: SnapshotImageResolution,
  parts: (TextContent | ImageContent)[],
): Promise<void> {
  const { blob, contentType } = await apiService.fetchImageByUrl(imageUrl);
  if (!contentType.startsWith("image/")) {
    parts.push({
      type: "text",
      text: `(${label}: unexpected content type ${contentType})`,
    });
    return;
  }

  if (imageResolution === "full") {
    parts.push({ type: "text", text: `### ${label} — full` });
    parts.push({
      type: "image",
      data: await blobToBase64(blob),
      mimeType: contentType,
    });
    return;
  }

  const preview = await createPreviewOrNull(blob, contentType);
  if (!preview) {
    parts.push({
      type: "text",
      text: `### ${label} — preview unavailable. Retry with imageResolution=full to fetch the original image.`,
    });
    return;
  }

  parts.push({ type: "text", text: `### ${label} — preview` });
  parts.push({
    type: "image",
    data: await blobToBase64(preview.blob),
    mimeType: preview.contentType,
  });
}

export async function fetchSnapshotImage(
  apiService: SentryApiService,
  organizationSlug: string,
  snapshotId: string,
  imageIdentifier: string,
  imageResolution: SnapshotImageResolution,
  options: {
    experimentalMode?: boolean;
    availableToolNames?: ReadonlySet<string>;
    directToolNames?: ReadonlySet<string>;
  } = {},
): Promise<(TextContent | ImageContent)[]> {
  const detail = (await apiService.getSnapshotImageDetail({
    organizationSlug,
    snapshotId,
    imageIdentifier,
  })) as SnapshotImageDetailResponse;

  const headImage = detail.head_image;
  const baseImage = detail.base_image;
  const status = detail.comparison_status;

  if (!headImage?.image_url && !baseImage?.image_url) {
    throw new UserInputError(
      `No image data returned for "${imageIdentifier}". The image may not exist in this snapshot.`,
    );
  }

  const snapshotUrl = `${apiService.getPreprodSnapshotUrl(
    organizationSlug,
    snapshotId,
  )}?selectedSnapshot=${encodeURIComponent(imageIdentifier)}`;

  const lines: string[] = [`## ${imageIdentifier}\n`];
  lines.push(`- **URL**: ${snapshotUrl}`);
  if (status) lines.push(`- **Status**: ${status}`);
  if (detail.diff_percentage != null)
    lines.push(
      `- **Diff**: ${formatSnapshotDiffPercent(detail.diff_percentage)}`,
    );
  if (detail.previous_image_file_name)
    lines.push(`- **Previous File**: \`${detail.previous_image_file_name}\``);
  lines.push(`- **Image Resolution**: ${imageResolution}`);
  if (imageResolution === "preview") {
    lines.push(
      fullResolutionHint({
        organizationSlug,
        snapshotId,
        imageIdentifier,
        experimentalMode: options.experimentalMode ?? false,
        availableToolNames: options.availableToolNames,
        directToolNames: options.directToolNames,
      }),
    );
  }

  const primary = headImage ?? baseImage;
  if (primary) lines.push(...formatImageMetadata(primary));

  const contentParts: (TextContent | ImageContent)[] = [
    { type: "text", text: lines.join("\n") },
  ];

  if (headImage?.image_url) {
    await fetchAndAppendImage(
      apiService,
      headImage.image_url,
      "Head (current)",
      imageResolution,
      contentParts,
    );
  }

  if (baseImage?.image_url && baseImage.image_url !== headImage?.image_url) {
    await fetchAndAppendImage(
      apiService,
      baseImage.image_url,
      "Base (previous)",
      imageResolution,
      contentParts,
    );
  }

  if (detail.diff_image_url) {
    await fetchAndAppendImage(
      apiService,
      detail.diff_image_url,
      "Diff Mask",
      imageResolution,
      contentParts,
    );
  }

  return contentParts;
}

function isSnapshotDiffPair(
  entry: SnapshotDiffPair | SnapshotImageEntry,
): entry is SnapshotDiffPair {
  return "head_image" in entry || "base_image" in entry;
}

function entryToTreeItem(
  entry: SnapshotDiffPair | SnapshotImageEntry,
): SnapshotImageTreeItem {
  if (isSnapshotDiffPair(entry)) {
    return { image: entry.head_image ?? entry.base_image ?? {} };
  }
  return { image: entry };
}

function renderTreeSections(
  sections: Array<{ title: string; items: SnapshotImageTreeItem[] }>,
): string[] {
  return sections.flatMap(({ title, items }, index) => {
    const lines = renderSnapshotImageTreeSection(title, items);
    if (lines.length === 0) {
      return [];
    }
    return index === 0 ? lines : ["", ...lines];
  });
}

export async function fetchSnapshotSummary(
  apiService: SentryApiService,
  organizationSlug: string,
  snapshotId: string,
  sourceUrlForDisplay: string | null,
  options: {
    showUnmodified?: boolean;
    listImagesWhenNoDiffs?: boolean;
    experimentalMode?: boolean;
    availableToolNames?: ReadonlySet<string>;
    directToolNames?: ReadonlySet<string>;
  } = {},
): Promise<string> {
  const data = (await apiService.getSnapshotDetails({
    organizationSlug,
    snapshotId,
    compactMetadata: true,
  })) as Record<string, unknown>;

  const comparisonType = data.comparison_type as string | null | undefined;
  const state = data.state as string | null | undefined;
  const projectId = data.project_id as string | number | null | undefined;
  const vcsInfo = data.vcs_info as SnapshotVcsInfo | undefined;
  const approvalInfo = data.approval_info as
    | { status?: string | null; is_auto_approved?: boolean | null }
    | undefined;

  const allImages = (data.images as SnapshotImageEntry[]) || [];
  const changed = (data.changed as SnapshotDiffPair[]) || [];
  const renamed = (data.renamed as SnapshotDiffPair[]) || [];
  const added = (data.added as SnapshotImageEntry[]) || [];
  const removed = (data.removed as SnapshotImageEntry[]) || [];
  const errored = (data.errored as SnapshotDiffPair[]) || [];
  const unchanged =
    (data.unchanged as Array<SnapshotDiffPair | SnapshotImageEntry>) || [];
  const skipped =
    (data.skipped as Array<SnapshotDiffPair | SnapshotImageEntry>) || [];

  const resolvedSnapshotUrl =
    sourceUrlForDisplay ||
    apiService.getPreprodSnapshotUrl(organizationSlug, snapshotId);

  const sections: string[] = [];

  sections.push(`# Snapshot ${snapshotId} in **${organizationSlug}**`);

  sections.push("\n## Summary\n");
  sections.push(`- **URL**: ${resolvedSnapshotUrl}`);
  sections.push(`- **Type**: ${comparisonType ?? "unknown"}`);
  sections.push(`- **State**: ${state ?? "unknown"}`);
  if (projectId) {
    sections.push(`- **Project ID**: ${projectId}`);
  }

  const totalCount = countField(data, "total_count", allImages.length);
  const changedCount = countField(data, "changed_count", changed.length);
  const addedCount = countField(data, "added_count", added.length);
  const removedCount = countField(data, "removed_count", removed.length);
  const renamedCount = countField(data, "renamed_count", renamed.length);
  const unchangedCount = countField(data, "unchanged_count", unchanged.length);
  const erroredCount = countField(data, "errored_count", errored.length);
  const skippedCount = countField(data, "skipped_count", skipped.length);
  sections.push(
    `- **Images**: ${totalCount} total (${changedCount} changed, ${addedCount} added, ${removedCount} removed, ${renamedCount} renamed, ${unchangedCount} unchanged, ${erroredCount} errored, ${skippedCount} skipped)`,
  );

  if (vcsInfo) {
    sections.push("\n## VCS Info\n");
    if (vcsInfo.repo_name) sections.push(`- **Repo**: ${vcsInfo.repo_name}`);
    if (vcsInfo.head_ref)
      sections.push(
        `- **Head**: ${vcsInfo.head_ref} (\`${(vcsInfo.head_sha ?? "").slice(0, 8)}\`)`,
      );
    if (vcsInfo.base_ref)
      sections.push(
        `- **Base**: ${vcsInfo.base_ref} (\`${(vcsInfo.base_sha ?? "").slice(0, 8)}\`)`,
      );
    if (vcsInfo.pr_number) sections.push(`- **PR**: #${vcsInfo.pr_number}`);
  }

  if (approvalInfo) {
    const status = approvalInfo.status ?? "unknown";
    const auto = approvalInfo.is_auto_approved ? " (auto-approved)" : "";
    sections.push(`\n- **Approval**: ${status}${auto}`);
  }

  const hasDiffs =
    changed.length > 0 ||
    renamed.length > 0 ||
    added.length > 0 ||
    removed.length > 0 ||
    errored.length > 0;

  if (hasDiffs) {
    sections.push("\n## Changes\n");

    const sortedChanged = [...changed].sort(
      (left, right) => (right.diff ?? -1) - (left.diff ?? -1),
    );

    sections.push(
      ...renderTreeSections([
        {
          title: "Changed",
          items: sortedChanged.map((pair) => ({
            image: pair.head_image ?? {},
            details:
              pair.diff != null
                ? [`${formatSnapshotDiffPercent(pair.diff)} diff`]
                : [],
          })),
        },
        { title: "Added", items: added.map((image) => ({ image })) },
        { title: "Removed", items: removed.map((image) => ({ image })) },
        {
          title: "Renamed",
          items: renamed.map((pair) => ({
            image: pair.head_image ?? {},
            details: [
              `previous: ${getSnapshotImageDisplayName(pair.base_image ?? {})}`,
            ],
          })),
        },
        {
          title: "Errored",
          items: errored.map((pair) => ({ image: pair.head_image ?? {} })),
        },
      ]),
    );
  } else if (
    (data.comparison_type === "solo" || options.listImagesWhenNoDiffs) &&
    allImages.length > 0
  ) {
    sections.push("\n## Images\n");
    sections.push(
      ...renderSnapshotImageTreeSection(
        "Snapshot Images",
        allImages.map((image) => ({ image })),
      ),
    );
  } else if (
    !options.showUnmodified &&
    (unchangedCount > 0 || skippedCount > 0)
  ) {
    sections.push(
      "\nNo changed images are shown in compact mode. Re-run `get_snapshot` with `showUnmodified=true` to list unchanged and skipped images.",
    );
  }

  if (options.showUnmodified && data.comparison_type !== "solo") {
    const unmodifiedSections = renderTreeSections([
      {
        title: "Unchanged",
        items: unchanged.map((entry) => entryToTreeItem(entry)),
      },
      {
        title: "Skipped",
        items: skipped.map((entry) => entryToTreeItem(entry)),
      },
    ]);

    if (unmodifiedSections.length > 0) {
      sections.push("\n## Unmodified\n");
      sections.push(...unmodifiedSections);
    }
  }

  sections.push(
    `\n## Next Steps\n\n- ${formatToolCallInstruction({
      toolName: "get_snapshot_image",
      arguments: {
        organizationSlug,
        snapshotId,
        imageIdentifier: "<image_file_name>",
      },
      experimentalMode: options.experimentalMode ?? false,
      availableToolNames: options.availableToolNames,
      directToolNames: options.directToolNames,
      fallbackInstruction: getSnapshotImagePreviewFallback(resolvedSnapshotUrl),
    })} to view a specific image preview\n${formatSnapshotImageFullResolutionStep(
      {
        organizationSlug,
        snapshotId,
        imageIdentifier: "<image_file_name>",
        experimentalMode: options.experimentalMode ?? false,
        availableToolNames: options.availableToolNames,
        directToolNames: options.directToolNames,
      },
    )}`,
  );

  return sections.join("\n");
}
