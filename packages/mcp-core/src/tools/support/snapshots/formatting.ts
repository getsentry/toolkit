export interface SnapshotImageEntry {
  display_name?: string | null;
  group?: string | null;
  image_file_name?: string;
  [key: string]: unknown;
}

/** VCS metadata attached to snapshot API responses. */
export interface SnapshotVcsInfo {
  repo_name?: string | null;
  head_ref?: string | null;
  head_sha?: string | null;
  base_ref?: string | null;
  base_sha?: string | null;
  pr_number?: number | null;
}

export function snapshotDiffPercent(diff: number): number {
  return Math.round(diff * 10000) / 100;
}

export function formatSnapshotDiffPercent(diff: number): string {
  return `${snapshotDiffPercent(diff)}%`;
}

export function renderSnapshotImageContext(context: unknown): string[] {
  return isPlainObject(context) ? renderContextObject(context, 0) : [];
}

function renderContextObject(
  context: Record<string, unknown>,
  depth: number,
): string[] {
  const prefix = "  ".repeat(depth);
  return Object.entries(context).flatMap(([key, value]) => {
    const formatted = formatSupportedContextValue(value);
    if (formatted !== null) {
      return [`${prefix}- **${key}**: ${formatted}`];
    }

    if (!isPlainObject(value)) {
      return [];
    }

    const children = renderContextObject(value, depth + 1);
    return children.length > 0 ? [`${prefix}- **${key}**:`, ...children] : [];
  });
}

function formatSupportedContextValue(value: unknown): string | null {
  if (typeof value === "string") {
    const normalized = value.trim().replace(/\s+/g, " ");
    return normalized.length > 0 ? normalized : null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : null;
  }

  if (typeof value === "boolean") {
    return String(value);
  }

  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
