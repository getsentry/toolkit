/**
 * Changed-files tree builder.
 *
 * Both `InkUI`'s React `<SummaryPanel>` / `<FilesPanel>` and
 * `LoggingUI.summary()` (plus the post-dispose chalk report) want a
 * nested directory tree view of the wizard's changed files —
 * collapses common prefixes and makes the actual scope of edits
 * visible at a glance.
 *
 * The pre-React formatter built this with `colorTag()` markdown tags
 * (`<green>+</green>`); the TUI couldn't render those because the
 * text renderer stripped ANSI/markdown. Keeping the tree as pure
 * data plus a flat render-list lets each renderer attach its own
 * colors / box-drawing.
 */

export type ChangedFile = {
  action: string;
  path: string;
};

/**
 * One entry in the read-files tree. `status` mirrors the
 * `FileReadEntry.status` shape from the wizard store so the Ink
 * `FilesPanel` can render an at-a-glance icon per row.
 */
export type ReadFile = {
  path: string;
  status: "reading" | "analyzed";
};

export type FileTreeNode = {
  /** Path segment for this node (e.g. "src", "router.tsx"). */
  name: string;
  /**
   * Full file path relative to the project root. Set only on leaf
   * (file) nodes. Directory nodes leave this `undefined`.
   */
  path?: string;
  /** Action recorded by the workflow — only on leaf nodes. */
  action?: string;
  /**
   * Read-progress status for the leaf — only set when the tree is
   * built from read entries (vs. changed files, which carry `action`
   * instead). Mutually exclusive with {@link FileTreeNode.action} in
   * practice; consumers branch on whichever is populated.
   */
  status?: "reading" | "analyzed";
  children: FileTreeNode[];
};

/**
 * Flat row produced by `flattenTree()` — one per visible line in the
 * rendered output. Carries everything a renderer needs to draw a
 * single row without re-walking the tree.
 */
export type FileTreeRow = {
  /** Box-drawing prefix for ancestor pipes (e.g. `"│  │  "`). */
  prefix: string;
  /** Branch glyph for this row — `"├─"` or `"└─"`. */
  branch: string;
  /**
   * `"file"` if this row represents a leaf (with action + path);
   * `"directory"` otherwise. Renderers use this to decide whether to
   * draw the action glyph cell.
   */
  kind: "file" | "directory";
  /** Display name. Directories get a trailing `/`. */
  label: string;
  /** Full path — only set on `file` rows. */
  path?: string;
  /** Action — only set on `file` rows from a changed-files tree. */
  action?: string;
  /**
   * Read-progress status — only set on `file` rows from a read-files
   * tree. Mutually exclusive with `action` in practice.
   */
  status?: "reading" | "analyzed";
};

function splitPath(filePath: string): string[] {
  return filePath
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0);
}

/**
 * Build a directory tree from the flat changed-files list. Files
 * sharing a common prefix collapse into nested directories.
 */
export function buildFileTree(files: ChangedFile[]): FileTreeNode {
  const root: FileTreeNode = { name: "", children: [] };

  // Maintain a parallel map keyed by parent reference so we can do
  // O(1) lookups for "does this directory already have a child named
  // X?" without scanning each parent's children array.
  const childIndex = new WeakMap<FileTreeNode, Map<string, FileTreeNode>>();
  childIndex.set(root, new Map());

  for (const file of files) {
    const parts = splitPath(file.path);
    let current = root;

    for (const [index, part] of parts.entries()) {
      const map = childIndex.get(current) ?? new Map<string, FileTreeNode>();
      let child = map.get(part);
      if (!child) {
        child = { name: part, children: [] };
        map.set(part, child);
        childIndex.set(current, map);
        childIndex.set(child, new Map());
        current.children.push(child);
      }

      if (index === parts.length - 1) {
        child.path = file.path;
        child.action = file.action;
      }

      current = child;
    }
  }

  sortRecursive(root);
  return root;
}

/**
 * Sort the tree in place: directories before files at each level,
 * then alphabetical within each group. Matches the legacy formatter's
 * ordering so existing screenshots/snapshots stay valid.
 */
function sortRecursive(node: FileTreeNode): void {
  node.children.sort((left, right) => {
    const leftIsDir = left.children.length > 0 && !left.action;
    const rightIsDir = right.children.length > 0 && !right.action;
    if (leftIsDir !== rightIsDir) {
      return leftIsDir ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
  for (const child of node.children) {
    sortRecursive(child);
  }
}

/**
 * Walk the tree and emit one {@link FileTreeRow} per line, ready to
 * be fed into a renderer. Directory nodes appear before their
 * children with the appropriate box-drawing prefix.
 */
export function flattenTree(root: FileTreeNode): FileTreeRow[] {
  const rows: FileTreeRow[] = [];
  walk(root.children, "", rows);
  return rows;
}

function walk(
  nodes: FileTreeNode[],
  prefix: string,
  rows: FileTreeRow[]
): void {
  for (const [index, node] of nodes.entries()) {
    const isLast = index === nodes.length - 1;
    rows.push(rowFor(node, prefix, isLast));
    if (node.children.length > 0) {
      const childPrefix = `${prefix}${isLast ? "   " : "│  "}`;
      walk(node.children, childPrefix, rows);
    }
  }
}

function rowFor(
  node: FileTreeNode,
  prefix: string,
  isLast: boolean
): FileTreeRow {
  // Files are leaves that carry either a change `action` (from
  // `buildFileTree`) or a read `status` (from `buildReadTree`). A
  // node with neither but a `path` set is also a file — covers
  // future tree builders that don't tag leaves.
  const isFile =
    Boolean(node.action) ||
    Boolean(node.status) ||
    (node.path !== undefined && node.children.length === 0);
  return {
    prefix,
    branch: isLast ? "└─" : "├─",
    kind: isFile ? "file" : "directory",
    label: isFile ? node.name : `${node.name}/`,
    ...(node.path !== undefined ? { path: node.path } : {}),
    ...(node.action !== undefined ? { action: node.action } : {}),
    ...(node.status !== undefined ? { status: node.status } : {}),
  };
}

/**
 * Build a directory tree from the wizard's read-files list. Mirrors
 * {@link buildFileTree} but tags leaves with `status` instead of
 * `action`.
 *
 * Insertion order is preserved (no sort) so newly-read files always
 * land at the bottom of their parent directory — gives the Ink
 * `FilesPanel`'s tail-window viewport a stable "tail -f" feel.
 */
export function buildReadTree(files: ReadFile[]): FileTreeNode {
  const root: FileTreeNode = { name: "", children: [] };
  const childIndex = new WeakMap<FileTreeNode, Map<string, FileTreeNode>>();
  childIndex.set(root, new Map());

  for (const file of files) {
    const parts = splitPath(file.path);
    let current = root;

    for (const [index, part] of parts.entries()) {
      const map = childIndex.get(current) ?? new Map<string, FileTreeNode>();
      let child = map.get(part);
      if (!child) {
        child = { name: part, children: [] };
        map.set(part, child);
        childIndex.set(current, map);
        childIndex.set(child, new Map());
        current.children.push(child);
      }

      if (index === parts.length - 1) {
        child.path = file.path;
        child.status = file.status;
      }

      current = child;
    }
  }

  // Deliberately no `sortRecursive(root)` — keep insertion order so
  // sticky-bottom scrollbox tracking feels right.
  return root;
}
