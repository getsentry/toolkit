import { z } from "zod";
import type { SnapshotImageEntry, SnapshotVcsInfo } from "./formatting";

// Field-by-field projections of preprod snapshot API objects. Snapshot API
// responses are untyped, so nothing here spreads upstream objects into
// structuredContent.

export const snapshotImageSchema = z.object({
  imageFileName: z.string().optional(),
  displayName: z.string().optional(),
  group: z.string().optional(),
  description: z.string().optional(),
});

type SnapshotImage = z.infer<typeof snapshotImageSchema>;

export const snapshotVcsSchema = z.object({
  repoName: z.string().optional(),
  headRef: z.string().optional(),
  headSha: z.string().optional(),
  baseRef: z.string().optional(),
  baseSha: z.string().optional(),
  prNumber: z.number().optional(),
});

type SnapshotVcs = z.infer<typeof snapshotVcsSchema>;

/** Returns a non-empty string, accepting numeric IDs and labels. */
export function snapshotString(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}

export function toSnapshotImage(image: SnapshotImageEntry): SnapshotImage {
  return withoutUndefined({
    imageFileName: snapshotString(image.image_file_name),
    displayName: snapshotString(image.display_name),
    group: snapshotString(image.group),
    description: snapshotString(image.description),
  });
}

export function toSnapshotVcs(
  vcsInfo: SnapshotVcsInfo | null | undefined,
): SnapshotVcs | null {
  if (!vcsInfo || typeof vcsInfo !== "object") {
    return null;
  }
  return withoutUndefined({
    repoName: snapshotString(vcsInfo.repo_name),
    headRef: snapshotString(vcsInfo.head_ref),
    headSha: snapshotString(vcsInfo.head_sha),
    baseRef: snapshotString(vcsInfo.base_ref),
    baseSha: snapshotString(vcsInfo.base_sha),
    prNumber: snapshotPrNumber(vcsInfo.pr_number),
  });
}

/** The snapshot API sends PR numbers as numbers or numeric strings. */
function snapshotPrNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return snapshotPrNumber(Number(value));
  }
  return undefined;
}
