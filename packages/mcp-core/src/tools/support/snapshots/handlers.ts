import type { ImageContent, TextContent } from "@modelcontextprotocol/server";
import type { SentryApiService } from "../../../api-client";
import { UserInputError } from "../../../errors";
import {
  type ImagePreviewResult,
  blobToBase64,
  createImagePreview,
} from "../../../internal/blob-utils";
import { formatToolCallInstruction } from "../../../internal/tool-helpers/tool-call-formatting";
import {
  formatSnapshotDiffPercent,
  renderSnapshotImageContext,
} from "./formatting";

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
