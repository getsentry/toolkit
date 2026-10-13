/** Validate Seer patches and apply a complete batch to its matching Git checkout. */
import { execFileSync } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { CliError, ValidationError } from "./errors.js";
import { parseRemoteUrl } from "./git.js";

/** Structural subset of an Explorer file patch required for local application. */
export type SeerPatch = {
  /** Repository identity, in owner/name form. */
  repo_name: string;
  /** One complete unified/Git diff for this file. */
  diff: string;
  /** File identity and operation reported by Seer. */
  patch: {
    /** Repository-relative file path (source or target for a rename). */
    path: string;
    /** Addition, modification (including rename), or deletion. */
    type: "A" | "M" | "D";
    /** Original file, optionally with the conventional a/ prefix. */
    source_file?: string;
    /** Resulting file, optionally with the conventional b/ prefix. */
    target_file?: string;
  };
};

/** Cancellation and absolute deadline checked before local mutation. */
export type SeerPatchOptions = {
  /** Caller cancellation signal. */
  signal?: AbortSignal;
  /** Absolute deadline, in milliseconds since the Unix epoch. */
  deadline?: number;
};

/** Validated source and destination, where null denotes /dev/null. */
type FilePaths = { source: string | null; target: string | null };

/** Portable alias keys include every directory prefix and Unicode normalization. */
function pathPrefixes(path: string): string[] {
  return path
    .split("/")
    .map((_segment, index, segments) => segments.slice(0, index + 1).join("/"));
}

/** Case and Unicode aliases can collide on macOS/Windows even with distinct Git names. */
function aliasKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

/** Require one consistent spelling for every affected file and directory. */
function validateAliases(
  path: string,
  aliases: Map<string, string>,
  register: boolean,
): void {
  for (const prefix of pathPrefixes(path)) {
    const key = aliasKey(prefix);
    const previous = aliases.get(key);
    if (previous !== undefined && previous !== prefix) {
      throw new ValidationError(
        `Seer patch path aliases another file or directory: ${prefix} and ${previous}. No files were changed.`,
      );
    }
    if (register) {
      aliases.set(key, prefix);
    }
  }
}

/** Run Git without a shell; input is passed on stdin rather than a command line. */
function git(args: string[], cwd: string, input?: string): string {
  return execFileSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 20 * 1024 * 1024,
  });
}

/** Reject paths whose interpretation could escape or change across platforms. */
function validatePath(path: string): void {
  const segments = path.split("/");
  if (
    !path ||
    /[\\:]/.test(path) ||
    [...path].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    ) ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        /[. ]$/.test(segment) ||
        segment.toLowerCase() === ".git",
    )
  ) {
    throw new ValidationError(
      `Unsafe Seer patch path: ${JSON.stringify(path)}.`,
    );
  }
}

/** Decode Git's C-quoted paths, including octal-escaped UTF-8 bytes. */
function decodePath(value: string): string {
  if (!value.startsWith('"')) {
    return value;
  }
  if (!value.endsWith('"')) {
    throw new ValidationError("Invalid quoted path in Seer patch.");
  }
  const bytes: number[] = [];
  const content = value.slice(1, -1);
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (char === "\\") {
      const escape = content.slice(i + 1).match(/^[0-7]{1,3}/)?.[0];
      if (escape) {
        bytes.push(Number.parseInt(escape, 8));
        i += escape.length;
        continue;
      }
      const next = content[++i];
      if (next !== '"' && next !== "\\") {
        throw new ValidationError("Unsafe escaped path in Seer patch.");
      }
      bytes.push(...Buffer.from(next));
    } else {
      const point = content.codePointAt(i);
      if (point === undefined) {
        throw new ValidationError("Invalid path in Seer patch.");
      }
      bytes.push(...Buffer.from(String.fromCodePoint(point)));
      if (point > 0xffff) {
        i++;
      }
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Header path, with timestamps removed and the required strip-one prefix checked. */
function headerPath(value: string, side: "a" | "b"): string | null {
  const path = decodePath(value.split("\t")[0] ?? "");
  if (path === "/dev/null") {
    return null;
  }
  if (!path.startsWith(`${side}/`)) {
    throw new ValidationError(`Seer diff paths must use the ${side}/ prefix.`);
  }
  const relative = path.slice(2);
  validatePath(relative);
  return relative;
}

/** Equivalent literal/C-quoted spellings accepted in a Git diff header. */
function pathSpellings(path: string): string[] {
  const octal = [...Buffer.from(path)]
    .map((byte) => {
      if (byte > 0x7e) {
        return `\\${byte.toString(8).padStart(3, "0")}`;
      }
      const char = String.fromCharCode(byte);
      return char === '"' ? '\\"' : char;
    })
    .join("");
  return [path, JSON.stringify(path), `"${octal}"`];
}

/** Match both Seer metadata and actual diff paths, before trusting either. */
function validateDiff(file: SeerPatch): FilePaths {
  validatePath(file.patch.path);
  const lines = file.diff.split("\n");
  const firstHunk = lines.findIndex((line) => line.startsWith("@@ "));
  const headers = (firstHunk < 0 ? lines : lines.slice(0, firstHunk)).map(
    (line) => line.replace(/\r$/, ""),
  );
  if (
    !file.diff.endsWith("\n") ||
    lines.filter((line) => line.startsWith("diff --git ")).length > 1 ||
    lines.some(
      (line) => line === "GIT binary patch" || line.startsWith("Binary files "),
    )
  ) {
    throw new ValidationError(
      "Seer patches must contain one complete text-file diff each.",
    );
  }
  const oldHeaders = headers.filter((line) => line.startsWith("--- "));
  const newHeaders = headers.filter((line) => line.startsWith("+++ "));
  const from = headers.filter((line) => line.startsWith("rename from "));
  const to = headers.filter((line) => line.startsWith("rename to "));
  if (
    oldHeaders.length > 1 ||
    newHeaders.length > 1 ||
    from.length > 1 ||
    to.length > 1 ||
    headers.some(
      (line) => line.startsWith("copy from ") || line.startsWith("copy to "),
    )
  ) {
    throw new ValidationError(
      "Seer patches must describe exactly one file operation.",
    );
  }
  let paths: FilePaths;
  const [oldHeader] = oldHeaders;
  const [newHeader] = newHeaders;
  const [renameFrom] = from;
  const [renameTo] = to;
  if (oldHeader !== undefined && newHeader !== undefined) {
    paths = {
      source: headerPath(oldHeader.slice(4), "a"),
      target: headerPath(newHeader.slice(4), "b"),
    };
  } else if (
    oldHeaders.length === 0 &&
    newHeaders.length === 0 &&
    renameFrom !== undefined &&
    renameTo !== undefined
  ) {
    paths = {
      source: decodePath(renameFrom.slice(12)),
      target: decodePath(renameTo.slice(10)),
    };
  } else {
    throw new ValidationError(
      "Seer patch is missing its source or target diff header.",
    );
  }
  for (const path of [paths.source, paths.target]) {
    if (path !== null) {
      validatePath(path);
    }
  }
  if (
    (file.patch.type === "A" &&
      (paths.source !== null || paths.target === null)) ||
    (file.patch.type === "D" &&
      (paths.source === null || paths.target !== null)) ||
    (file.patch.type === "M" &&
      (paths.source === null || paths.target === null)) ||
    ![paths.source, paths.target].includes(file.patch.path)
  ) {
    throw new ValidationError(
      "Seer patch operation or path does not match its diff headers.",
    );
  }
  for (const [metadata, path, side] of [
    [file.patch.source_file, paths.source, "a"],
    [file.patch.target_file, paths.target, "b"],
  ] as const) {
    if (metadata !== undefined) {
      if (metadata !== "/dev/null") {
        validatePath(metadata);
      }
      if (
        path === null
          ? metadata !== "/dev/null"
          : metadata !== path && metadata !== `${side}/${path}`
      ) {
        throw new ValidationError(
          "Seer patch metadata does not match its diff headers.",
        );
      }
    }
  }
  const original = paths.source ?? paths.target;
  const destination = paths.target ?? paths.source;
  if (original === null || destination === null) {
    throw new ValidationError(
      "Seer patch must describe at least one file path.",
    );
  }
  const gitHeaders = headers.filter((line) => line.startsWith("diff --git "));
  if (
    gitHeaders.some(
      (line) =>
        !pathSpellings(`a/${original}`).some((old) =>
          pathSpellings(`b/${destination}`).some(
            (next) => line === `diff --git ${old} ${next}`,
          ),
        ),
    )
  ) {
    throw new ValidationError(
      "Seer Git diff header does not match its file paths.",
    );
  }
  if (
    from.length !== to.length ||
    (renameFrom !== undefined &&
      renameTo !== undefined &&
      (decodePath(renameFrom.slice(12)) !== paths.source ||
        decodePath(renameTo.slice(10)) !== paths.target))
  ) {
    throw new ValidationError(
      "Seer rename headers do not match its file paths.",
    );
  }
  for (const line of headers) {
    const mode =
      line.match(
        /^(?:new file mode|deleted file mode|old mode|new mode) (\d+)$/,
      )?.[1] ?? line.match(/^index \S+ (\d+)$/)?.[1];
    if (mode !== undefined && mode !== "100644" && mode !== "100755") {
      throw new ValidationError(
        "Seer patches cannot create or modify symlinks or submodules.",
      );
    }
  }
  return paths;
}

/** Reject symlinks at every existing segment, including the file itself. */
async function validateFilesystemPath(
  root: string,
  path: string,
): Promise<void> {
  let current = root;
  for (const segment of path.split("/")) {
    current = join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) {
        throw new ValidationError(
          `Seer patch path crosses a symlink: ${path}.`,
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
  }
}

/** Verify Git sees the same single file as the metadata/header validation. */
function validateGitPaths(
  root: string,
  file: SeerPatch,
  paths: FilePaths,
): void {
  let output: string;
  try {
    output = git(["apply", "--numstat", "-z", "-"], root, file.diff);
  } catch {
    throw new ValidationError(
      "Seer patch is not a valid text-file diff. No files were changed.",
    );
  }
  const records = output.split("\0");
  const header = records[0]?.match(/^\d+\t\d+\t(.*)$/);
  const reported = header?.[1];
  const valid =
    reported === ""
      ? records.length === 4 &&
        records[1] === paths.source &&
        records[2] === paths.target &&
        records[3] === ""
      : records.length === 2 &&
        reported === (paths.target ?? paths.source) &&
        records[1] === "";
  if (!valid) {
    throw new ValidationError(
      "Seer patch contains unexpected file paths or additional file diffs. No files were changed.",
    );
  }
}

/**
 * Apply all patches after validating repository identity, paths, and local conflicts.
 * Git checks the entire batch before writes. Unrelated local edits are preserved.
 * @param patches - File diffs from one Seer result.
 * @param cwd - Any directory inside the target Git checkout.
 * @param options - Cancellation/deadline checked at entry and before Git writes.
 * @returns All affected repository-relative paths, including both sides of renames.
 * @throws ValidationError for unsafe/conflicting input; CliError for Git failures.
 */
export async function applySeerPatches(
  patches: readonly SeerPatch[],
  cwd: string,
  options: SeerPatchOptions = {},
): Promise<{ applied: string[] }> {
  const assertActive = (): void => {
    if (options.signal?.aborted) {
      throw new CliError(
        "Seer patch application was cancelled. No files were changed.",
      );
    }
    if (
      options.deadline !== undefined &&
      (!Number.isFinite(options.deadline) || Date.now() >= options.deadline)
    ) {
      throw new CliError(
        "Seer patch application timed out. No files were changed.",
      );
    }
  };
  assertActive();
  if (patches.length === 0) {
    return { applied: [] };
  }
  if (new Set(patches.map((patch) => patch.repo_name)).size > 1) {
    throw new ValidationError(
      "Cannot apply a multi-repository Seer patch batch to one checkout. Select code changes from one repository. No files were changed.",
    );
  }
  let root: string;
  let remotes: Set<string>;
  try {
    root = await realpath(git(["rev-parse", "--show-toplevel"], cwd).trim());
    const remoteNames = git(["remote"], root)
      .trim()
      .split("\n")
      .filter((name) => name === "origin" || name === "upstream");
    remotes = new Set(
      remoteNames
        .map((name) =>
          parseRemoteUrl(git(["remote", "get-url", name], root).trim()),
        )
        .filter((name): name is string => name !== undefined),
    );
  } catch {
    throw new CliError(
      "Cannot apply Seer patches: run this command inside a Git checkout with an origin or upstream remote.",
    );
  }
  if (patches.some((patch) => !remotes.has(patch.repo_name))) {
    throw new ValidationError(
      "Cannot apply Seer patches: every patch repository must match this checkout's origin or upstream remote. No files were changed.",
    );
  }
  const affected = new Set<string>();
  const aliases = new Map<string, string>();
  for (const patch of patches) {
    const paths = validateDiff(patch);
    validateGitPaths(root, patch, paths);
    for (const path of new Set([paths.source, paths.target])) {
      if (path !== null) {
        if (affected.has(path)) {
          throw new ValidationError(
            `Seer patch batch affects the same path more than once: ${path}.`,
          );
        }
        affected.add(path);
        validateAliases(path, aliases, true);
        await validateFilesystemPath(root, path);
      }
    }
  }
  const changed = git(
    ["diff", "--no-ext-diff", "--name-only", "-z"],
    root,
  ).split("\0");
  const staged = git(
    ["diff", "--cached", "--no-ext-diff", "--name-only", "-z"],
    root,
  ).split("\0");
  const untracked = git(["ls-files", "--others", "-z"], root).split("\0");
  const tracked = git(["ls-files", "-z"], root).split("\0");
  for (const path of [...tracked, ...untracked]) {
    if (path) {
      validateAliases(path, aliases, false);
    }
  }
  const conflicts = new Set([...changed, ...staged, ...untracked]);
  for (const path of affected) {
    if (conflicts.has(path)) {
      throw new ValidationError(
        `Cannot apply Seer patch to ${path}: the file has local changes or is untracked. Commit or move those changes first.`,
      );
    }
  }
  const diff = patches.map((patch) => patch.diff).join("\n");
  try {
    git(
      ["apply", "--check", "--index", "--whitespace=nowarn", "-"],
      root,
      diff,
    );
  } catch {
    throw new ValidationError(
      "Seer patches could not be applied cleanly. No files were changed; review the diffs and checkout before retrying.",
    );
  }
  assertActive();
  try {
    git(["apply", "--whitespace=nowarn", "-"], root, diff);
  } catch {
    throw new CliError(
      "Git could not apply the Seer patches. Review the checkout and saved diffs before retrying.",
    );
  }
  return { applied: [...affected] };
}
