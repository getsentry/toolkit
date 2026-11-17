import { z } from "zod";
import type { SnapshotImageEntry, SnapshotVcsInfo } from "./formatting";

// Field-by-field projections of preprod snapshot API objects. Snapshot API
// responses are untyped, so nothing here spreads upstream objects into
// structuredContent.

export const snapshotImageSchema = z.object({
  imageFileName: z.string().optional(),
  displayName: z.string().optional(),
  description: z.string().optional(),
});

type SnapshotImage = z.infer<typeof snapshotImageSchema>;

/** Images bucketed by their snapshot group; ungrouped images use null. */
export function snapshotGroupsOf<T extends z.ZodType>(image: T) {
  return z.array(
    z.object({
      group: z.string().nullable(),
      images: z.array(image),
    }),
  );
}

export const snapshotImageGroupsSchema = snapshotGroupsOf(snapshotImageSchema);

type SnapshotImageGroups = z.infer<typeof snapshotImageGroupsSchema>;

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

/** Keeps only object entries; snapshot API arrays are untyped. */
export function snapshotImageEntries(value: unknown): SnapshotImageEntry[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is SnapshotImageEntry =>
          !!entry && typeof entry === "object" && !Array.isArray(entry),
      )
    : [];
}

export function toSnapshotImage(image: SnapshotImageEntry): SnapshotImage {
  return withoutUndefined({
    imageFileName: snapshotString(image.image_file_name),
    displayName: snapshotString(image.display_name),
    description: snapshotString(image.description),
  });
}

/** Buckets images by group, keeping first-seen order. */
export function groupSnapshotImages<TItem, TMapped>(
  items: TItem[],
  imageOf: (item: TItem) => SnapshotImageEntry,
  map: (item: TItem) => TMapped,
): Array<{ group: string | null; images: TMapped[] }> {
  const groups = new Map<string | null, TMapped[]>();
  for (const item of items) {
    const group = snapshotString(imageOf(item).group) ?? null;
    const mapped = map(item);
    const existing = groups.get(group);
    if (existing) {
      existing.push(mapped);
    } else {
      groups.set(group, [mapped]);
    }
  }
  return [...groups].map(([group, images]) => ({ group, images }));
}

export function toSnapshotImageGroups(
  images: SnapshotImageEntry[],
): SnapshotImageGroups {
  return groupSnapshotImages(images, (image) => image, toSnapshotImage);
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
