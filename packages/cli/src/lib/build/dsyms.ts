/** dSYM discovery and disk-backed ZIP extraction for IPA uploads. */
import { createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { pipeline } from "node:stream/promises";
import { openPromise } from "yauzl";
import { ValidationError } from "../errors.js";
import { logger } from "../logger.js";

const log = logger.withTag("build.dsyms");

/** A file to stream into the XCArchive's `dSYMs/` tree. */
export type DsymEntry = { relPath: string; sourcePath: string };

function hasDsymExtension(name: string): boolean {
  return name.toLowerCase().endsWith(".dsym");
}

function isMacosMetadata(name: string): boolean {
  return name
    .split("/")
    .some(
      (part) =>
        part === "__MACOSX" || part === ".DS_Store" || part.startsWith("._"),
    );
}

/** Collect file paths without reading their contents or following symlinks. */
async function collectBundle(
  bundle: string,
  prefix: string,
): Promise<DsymEntry[]> {
  const entries: DsymEntry[] = [];
  for (const dirent of await readdir(bundle, { withFileTypes: true })) {
    const sourcePath = join(bundle, dirent.name);
    const relPath = `${prefix}/${dirent.name}`;
    if (dirent.isSymbolicLink()) {
      throw new ValidationError(
        "Symlinks are not supported in dSYM bundles",
        "dsym",
      );
    }
    if (dirent.isDirectory()) {
      entries.push(...(await collectBundle(sourcePath, relPath)));
    } else if (dirent.isFile()) {
      entries.push({ relPath, sourcePath });
    } else {
      throw new ValidationError("Unsupported file type in dSYM bundle", "dsym");
    }
  }
  return entries;
}

/** ZIPs may wrap their bundles in one directory; directory inputs never do. */
async function discoverBundles(
  root: string,
  allowWrapper: boolean,
): Promise<string[]> {
  if (hasDsymExtension(root)) {
    return [root];
  }
  const bundles: string[] = [];
  const directories: string[] = [];
  for (const dirent of await readdir(root, { withFileTypes: true })) {
    if (dirent.isSymbolicLink() && hasDsymExtension(dirent.name)) {
      throw new ValidationError("dSYM paths cannot be symlinks", "dsym");
    }
    if (dirent.isDirectory()) {
      const full = join(root, dirent.name);
      (hasDsymExtension(dirent.name) ? bundles : directories).push(full);
    }
  }
  const [onlyDirectory] = directories;
  if (
    bundles.length === 0 &&
    allowWrapper &&
    directories.length === 1 &&
    onlyDirectory
  ) {
    return await discoverBundles(onlyDirectory, false);
  }
  return bundles;
}

/** Stream entries from the real central directory, preserving their type checks. */
async function extractDsymZip(zipPath: string, destDir: string): Promise<void> {
  try {
    const zip = await openPromise(zipPath, {
      lazyEntries: true,
      autoClose: false,
    });
    try {
      // yauzl walks the EOCD-declared central directory and normalizes Windows
      // separators before rejecting absolute/traversal names. Scanning for PK
      // signatures in file data cannot establish an entry's type or safety.
      for await (const entry of zip.eachEntry()) {
        // oxlint-disable-next-line no-bitwise -- ZIP attributes encode the Unix file type in the upper 16 bits
        const fileType = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (fileType === 0o120000) {
          throw new ValidationError(
            "Symlinks are not supported in dSYM ZIPs",
            "dsym",
          );
        }
        const target = resolve(destDir, entry.fileName);
        const rel = relative(destDir, target);
        if (
          !rel ||
          rel.split(/[/\\]/).includes("..") ||
          isAbsolute(rel) ||
          entry.fileName.includes("\0")
        ) {
          throw new ValidationError("Unsafe path in dSYM ZIP", "dsym");
        }
        // Validate every entry before skipping metadata or directory markers;
        // an unsafe entry always rejects the entire archive.
        if (isMacosMetadata(entry.fileName)) {
          continue;
        }
        if (entry.fileName.endsWith("/")) {
          await mkdir(target, { recursive: true });
          continue;
        }
        await mkdir(dirname(target), { recursive: true });
        const source = await zip.openReadStreamPromise(entry);
        await pipeline(
          source,
          createWriteStream(target, { flags: "wx", mode: 0o600 }),
        );
      }
    } finally {
      zip.close();
    }
  } catch (err) {
    if (err instanceof ValidationError) {
      throw err;
    }
    // ZIP parser errors may contain archive-controlled text; never surface it.
    log.debug("Failed to extract a dSYM ZIP");
    throw new ValidationError("Invalid or unsafe dSYM ZIP archive", "dsym");
  }
}

/**
 * Collect bundles, directories of bundles, or ZIPs for an IPA upload.
 *
 * `stageDir` belongs to the normalizer and must survive until the wrapper has
 * streamed every returned sourcePath. The normalizer removes it in finally,
 * including on discovery, extraction, normalization, and upload failures.
 */
export async function collectDsymEntries(
  paths: readonly string[],
  stageDir: string,
): Promise<DsymEntry[]> {
  const entries: DsymEntry[] = [];
  const seenBundles = new Set<string>();
  for (const input of paths) {
    // resolve strips trailing separators before lstat and extension detection.
    // lstat("link.dSYM/") would otherwise follow a directory symlink on POSIX.
    const inputPath = resolve(input);
    const stats = await lstat(inputPath).catch(() => {
      throw new ValidationError(`dSYM path does not exist: ${input}`, "dsym");
    });
    if (stats.isSymbolicLink()) {
      throw new ValidationError("dSYM paths cannot be symlinks", "dsym");
    }
    if (!stats.isFile() && !stats.isDirectory()) {
      throw new ValidationError(
        "dSYM path must be a bundle, directory, or ZIP archive",
        "dsym",
      );
    }
    const root = stats.isFile()
      ? await mkdtemp(join(stageDir, "dsym-"))
      : inputPath;
    if (stats.isFile()) {
      await extractDsymZip(inputPath, root);
    }
    const bundles = await discoverBundles(root, stats.isFile());
    if (bundles.length === 0) {
      throw new ValidationError(`No .dSYM bundles found: ${input}`, "dsym");
    }
    for (const bundle of bundles) {
      const bundleName = basename(bundle);
      if (seenBundles.has(bundleName)) {
        throw new ValidationError(
          `Cannot include multiple dSYM bundles named ${bundleName}`,
          "dsym",
        );
      }
      seenBundles.add(bundleName);
      const files = await collectBundle(bundle, bundleName);
      if (files.length === 0) {
        throw new ValidationError(
          `dSYM bundle contains no files: ${bundleName}`,
          "dsym",
        );
      }
      entries.push(...files);
    }
  }
  return entries;
}
