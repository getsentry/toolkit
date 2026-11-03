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

export interface SnapshotImageTreeItem {
  image: SnapshotImageEntry;
  details?: string[];
}

interface TreeBranch {
  kind: "branch";
  label: string;
  children: Map<string, TreeBranch>;
  leaves: TreeLeaf[];
}

interface TreeLeaf {
  kind: "leaf";
  label: string;
}

type TreeEntry = TreeBranch | TreeLeaf;

export function getSnapshotImageDisplayName(img: SnapshotImageEntry): string {
  return img.display_name || img.image_file_name || "unknown";
}

export function formatSnapshotDiffPercent(diff: number): string {
  return `${Math.round(diff * 10000) / 100}%`;
}

export function renderSnapshotImageTreeSection(
  title: string,
  items: SnapshotImageTreeItem[],
): string[] {
  if (items.length === 0) {
    return [];
  }

  const root = createBranch("");
  for (const item of items) {
    addItemToBranch(root, item);
  }

  const lines = [`**${title}:**`];
  const entries = collectChildEntries(root);
  for (const [index, entry] of entries.entries()) {
    lines.push(renderEntry(entry, "", index === entries.length - 1));
  }
  return lines;
}

export function renderSnapshotImageContext(context: unknown): string[] {
  return isPlainObject(context) ? renderContextObject(context, 0) : [];
}

function createBranch(label: string): TreeBranch {
  return { kind: "branch", label, children: new Map(), leaves: [] };
}

function addItemToBranch(root: TreeBranch, item: SnapshotImageTreeItem): void {
  const identifier = getSnapshotImageIdentifier(item.image);
  const segments = identifier.split("/").filter(Boolean);
  const pathSegments = segments.length > 0 ? segments : [identifier];
  const leafName = pathSegments[pathSegments.length - 1] ?? identifier;

  let node = root;
  for (const segment of pathSegments.slice(0, -1)) {
    let child = node.children.get(segment);
    if (!child) {
      child = createBranch(`${segment}/`);
      node.children.set(segment, child);
    }
    node = child;
  }

  node.leaves.push({
    kind: "leaf",
    label: formatLeafLabel(leafName, item.image, item.details ?? []),
  });
}

function getSnapshotImageIdentifier(img: SnapshotImageEntry): string {
  return img.image_file_name || getSnapshotImageDisplayName(img);
}

function formatLeafLabel(
  leafName: string,
  img: SnapshotImageEntry,
  details: string[],
): string {
  const displayName = getSnapshotImageDisplayName(img);
  const suffixes = [...details];

  // Only surface the display name when it adds information beyond the
  // file name (leaf) and isn't already the image_file_name.
  if (displayName !== leafName && displayName !== img.image_file_name) {
    suffixes.push(displayName);
  }
  if (img.group && String(img.group) !== displayName) {
    suffixes.push(String(img.group));
  }

  return suffixes.length > 0
    ? `${leafName} — ${suffixes.join(" — ")}`
    : leafName;
}

function collectChildEntries(branch: TreeBranch): TreeEntry[] {
  return [...branch.children.values(), ...branch.leaves];
}

function renderEntry(
  entry: TreeEntry,
  prefix: string,
  isLast: boolean,
): string {
  const connector = isLast ? "└── " : "├── ";

  if (entry.kind === "leaf") {
    return `${prefix}${connector}${entry.label}`;
  }

  const childPrefix = `${prefix}${isLast ? "    " : "│   "}`;
  const children = collectChildEntries(entry);
  const lines = [`${prefix}${connector}${entry.label}`];

  for (const [index, child] of children.entries()) {
    lines.push(renderEntry(child, childPrefix, index === children.length - 1));
  }
  return lines.join("\n");
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
