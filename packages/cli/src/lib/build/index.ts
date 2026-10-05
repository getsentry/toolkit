/**
 * Mobile build normalization for `sentry build upload`.
 *
 * Detects the build format from ZIP entry names and wraps the build into a
 * deterministic ZIP (STORE compression, fixed mtime) alongside a metadata
 * file, ready for chunk upload + assembly.
 *
 * Determinism matters: a byte-identical wrapper for an identical build lets the
 * server dedup already-uploaded chunks across re-uploads. We use STORE (level 0)
 * because APK/AAB/IPA are themselves already-compressed ZIPs — re-compressing
 * the wrapper would cost CPU for ~no size win — and a fixed modification time so
 * the output does not vary run to run.
 *
 * Note: the legacy Rust CLI compresses the wrapper with Zstd. STORE is chosen
 * here deliberately (simpler, no method-93 ZIP writer needed, avoids
 * double-compression). The tradeoff is that wrapper bytes differ from the Rust
 * CLI's, so chunks are not deduplicated across the two CLIs — only within this
 * one, which is what matters for repeated uploads from the same tool.
 *
 * Handles Android APK/AAB (file wrappers) and iOS XCArchive (directory) / IPA
 * (converted to an XCArchive layout). Unlike the legacy CLI, iOS is not gated to
 * Apple Silicon — the only native dependency was `Assets.car` parsing, which is
 * intentionally skipped (see `normalizeBuildDirectory`).
 */

import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  statSync,
  writeSync,
} from "node:fs";
import { lstat, mkdtemp, open, readdir, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  strToU8,
  Unzip,
  type UnzipFile,
  UnzipInflate,
  UnzipPassThrough,
  unzipSync,
} from "fflate";
import { CLI_VERSION } from "../constants.js";
import { ValidationError } from "../errors.js";
import { logger } from "../logger.js";
import { DeterministicZipWriter } from "./zip-writer.js";

const log = logger.withTag("build.normalize");

/** A recognized mobile build format. */
export type BuildFormat = "apk" | "aab" | "ipa" | "xcarchive";

/** ZIP local-file-header magic bytes (`PK\x03\x04`). */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

/** Name of the metadata file embedded in every normalized build ZIP. */
const METADATA_FILENAME = ".sentry-cli-metadata.txt";

/** Whether the bytes start with the ZIP local-file-header magic. */
function hasZipMagic(bytes: Uint8Array): boolean {
  return ZIP_MAGIC.every((byte, i) => bytes[i] === byte);
}

/**
 * List a ZIP's entry names without decompressing any entry.
 *
 * The fflate filter is invoked for every entry; returning `false` skips
 * decompression, so this only parses the central directory.
 */
function listZipEntryNames(content: Uint8Array): string[] {
  const names: string[] = [];
  unzipSync(content, {
    filter: (file) => {
      names.push(file.name);
      return false;
    },
  });
  return names;
}

/** Classify a build format from a ZIP's entry names (order-independent). */
function classifyBuildFormat(names: string[]): BuildFormat | null {
  const entries = new Set(names);
  // AAB is more specific than APK (an AAB also nests an AndroidManifest under
  // base/), so check it first.
  if (
    entries.has("BundleConfig.pb") &&
    entries.has("base/manifest/AndroidManifest.xml")
  ) {
    return "aab";
  }
  if (entries.has("AndroidManifest.xml")) {
    return "apk";
  }
  // IPA: a Payload/<name>.app/Info.plist entry (recognized so the caller can
  // emit an "iOS not yet supported" message rather than "unrecognized").
  if (names.some((name) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(name))) {
    return "ipa";
  }
  return null;
}

/**
 * Detect the mobile build format from a file's bytes.
 *
 * APK/AAB/IPA are recognized by their ZIP entry names. Returns `null` for
 * anything unrecognized. (XCArchive is a directory, not a file, and is detected
 * by the caller.)
 *
 * @param content - The raw build file bytes.
 */
export function detectBuildFormat(content: Uint8Array): BuildFormat | null {
  if (!hasZipMagic(content)) {
    return null;
  }

  let names: string[];
  try {
    names = listZipEntryNames(content);
  } catch (err) {
    log.debug("Failed to read ZIP entries while detecting build format", err);
    return null;
  }

  return classifyBuildFormat(names);
}

/**
 * Detect the mobile build format by streaming a file from disk.
 *
 * Reads the ZIP's entry names via a streaming unzip (local headers only — entry
 * data is never decompressed or buffered), so large APK/AAB/IPA files are
 * classified without loading them into memory. Returns `null` for a non-ZIP or
 * an unrecognized ZIP.
 *
 * @param filePath - Path to the build file.
 */
export async function detectBuildFormatFromFile(
  filePath: string
): Promise<BuildFormat | null> {
  const src = await open(filePath, "r");
  try {
    // Cheap magic check first: a non-ZIP would otherwise make Unzip throw.
    const magic = Buffer.alloc(ZIP_MAGIC.length);
    const { bytesRead } = await src.read(magic, 0, magic.length, 0);
    if (bytesRead < ZIP_MAGIC.length || !hasZipMagic(magic)) {
      return null;
    }

    const names: string[] = [];
    const unzip = new Unzip();
    unzip.register(UnzipInflate);
    unzip.register(UnzipPassThrough);
    // Record each entry name but never call `file.start()`, so fflate skips the
    // entry's data entirely (no decompression, no buffering).
    unzip.onfile = (file: UnzipFile) => {
      names.push(file.name);
    };

    const buf = Buffer.allocUnsafe(1 << 20);
    const size = (await src.stat()).size;
    let position = 0;
    while (position < size) {
      const read = await src.read(buf, 0, buf.length, position);
      if (read.bytesRead === 0) {
        break;
      }
      position += read.bytesRead;
      unzip.push(
        Uint8Array.prototype.slice.call(buf, 0, read.bytesRead),
        position >= size
      );
    }
    return classifyBuildFormat(names);
  } catch (err) {
    log.debug("Failed to read ZIP entries while detecting build format", err);
    return null;
  } finally {
    await src.close();
  }
}

/** A Sentry build plugin parsed from `SENTRY_PIPELINE`. */
export type PipelinePlugin = { name: string; version: string };

/**
 * Parse a recognized Sentry plugin from a `SENTRY_PIPELINE` value.
 *
 * Format: `"<name>/<version>"` (e.g. `"sentry-gradle-plugin/4.12.0"`). Only the
 * gradle and fastlane plugins are recognized; anything else yields `null`.
 *
 * @param pipeline - The `SENTRY_PIPELINE` value, if set.
 */
export function parsePluginFromPipeline(
  pipeline: string | undefined
): PipelinePlugin | null {
  if (!pipeline) {
    return null;
  }
  const slash = pipeline.indexOf("/");
  if (slash <= 0) {
    return null;
  }
  const name = pipeline.slice(0, slash);
  const version = pipeline.slice(slash + 1);
  if (
    version &&
    (name === "sentry-gradle-plugin" || name === "sentry-fastlane-plugin")
  ) {
    return { name, version };
  }
  return null;
}

/** Build the `.sentry-cli-metadata.txt` contents. */
function buildMetadataFile(plugin: PipelinePlugin | null): string {
  const version =
    process.env.SENTRY_CLI_INTEGRATION_TEST_VERSION_OVERRIDE ?? CLI_VERSION;
  let out = `sentry-cli-version: ${version}\n`;
  if (plugin) {
    out += `${plugin.name}: ${plugin.version}\n`;
  }
  return out;
}

/**
 * Wrap a build file into a deterministic normalized ZIP written to `outPath`.
 *
 * The ZIP stores the build under its basename plus `.sentry-cli-metadata.txt`,
 * using STORE (no compression) and a fixed mtime so identical inputs produce
 * identical bytes. The build file is streamed from disk into the wrapper, so
 * neither the build nor the wrapper is held in memory in full.
 *
 * @param filePath - Path to the build file (its basename becomes the ZIP entry).
 * @param outPath - Destination path for the normalized wrapper ZIP.
 * @param plugin - Optional plugin identity for the metadata file.
 */
export async function normalizeBuildFile(
  filePath: string,
  outPath: string,
  plugin: PipelinePlugin | null
): Promise<void> {
  const zip = await DeterministicZipWriter.create(outPath);
  try {
    await zip.addFile(basename(filePath), filePath);
    await zip.addData(METADATA_FILENAME, strToU8(buildMetadataFile(plugin)));
    await zip.finalize();
  } catch (err) {
    await zip.close();
    throw err;
  }
}

/** `os` = 3 (Unix) — required for `attrs` to carry Unix mode bits in a ZIP. */
const ZIP_OS_UNIX = 3;

/**
 * Recursively find `.app` bundle directories under `dir` (does not descend into
 * a `.app` once found), mirroring the legacy CLI's `Products/**` + `*.app` glob.
 */
function findAppBundles(dir: string): string[] {
  const found: string[] = [];
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }
    const full = join(dir, dirent.name);
    if (dirent.name.endsWith(".app")) {
      found.push(full);
    } else {
      found.push(...findAppBundles(full));
    }
  }
  return found;
}

/**
 * Validate that a directory is a real XCArchive before it is zipped and
 * uploaded — mirrors the legacy CLI's `validate_xcarchive_directory`.
 *
 * Guards against accidentally uploading an arbitrary directory (e.g. a project
 * root, which would sweep up `.git/`, `node_modules/`, and `.env` secrets).
 * Requires a root `Info.plist`, a `Products/` directory, and at least one
 * `.app` bundle (each with its own `Info.plist`).
 *
 * @throws {ValidationError} If the directory is not a valid XCArchive.
 */
export function validateXcarchiveDirectory(dirPath: string): void {
  const root = resolve(dirPath);
  if (!existsSync(join(root, "Info.plist"))) {
    throw new ValidationError(
      "Invalid XCArchive: missing Info.plist at the archive root",
      "path"
    );
  }
  const products = join(root, "Products");
  if (!(existsSync(products) && statSync(products).isDirectory())) {
    throw new ValidationError(
      "Invalid XCArchive: missing Products/ directory",
      "path"
    );
  }
  const apps = findAppBundles(products);
  if (apps.length === 0) {
    throw new ValidationError(
      "Invalid XCArchive: no .app bundles found under Products/",
      "path"
    );
  }
  for (const app of apps) {
    if (!existsSync(join(app, "Info.plist"))) {
      throw new ValidationError(
        `Invalid XCArchive: missing Info.plist in .app bundle: ${basename(app)}`,
        "path"
      );
    }
  }
}

/**
 * A collected archive entry. Files carry a `sourcePath` (streamed from disk);
 * symlinks carry inline `linkTarget` bytes (never followed). `attrs` holds the
 * Unix mode in the upper 16 bits.
 */
type ArchiveEntry = {
  relPath: string;
  attrs: number;
} & ({ sourcePath: string } | { linkTarget: Uint8Array });

/**
 * Recursively collect an XCArchive's entries, preserving symlinks and Unix
 * permissions (via ZIP external attributes) exactly as the legacy CLI does.
 *
 * File contents are NOT read here — only the source path is recorded, so the
 * bytes can later be streamed straight into the wrapper ZIP without buffering
 * the whole tree in memory.
 *
 * A custom walk (rather than the shared file walker) is used because fidelity
 * matters here: symlinks are stored as symlink entries (their target string as
 * content, `S_IFLNK` in the mode) — NOT followed — so Apple framework/dSYM
 * bundles aren't restructured or their binaries duplicated, which would corrupt
 * the server's size analysis. Symlinked directories are recorded as links and
 * not descended into, matching the Rust `WalkDir` (follow_links = false).
 */
async function collectArchiveEntries(root: string): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];

  const walk = async (dir: string, prefix: string): Promise<void> => {
    const dirents = await readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      const full = join(dir, dirent.name);
      const relPath = prefix ? `${prefix}/${dirent.name}` : dirent.name;

      // Check symlink first: a symlink to a directory must be stored as a link,
      // not descended into (matching Rust's WalkDir with follow_links = false).
      let payload: { sourcePath: string } | { linkTarget: Uint8Array };
      if (dirent.isSymbolicLink()) {
        payload = { linkTarget: strToU8(await readlink(full)) };
      } else if (dirent.isDirectory()) {
        await walk(full, relPath);
        continue;
      } else if (dirent.isFile()) {
        payload = { sourcePath: full };
      } else {
        // Skip sockets, FIFOs, and other special files.
        continue;
      }

      // Encode the full Unix mode (type + permission bits) into the upper 16
      // bits of the ZIP external attributes so symlinks and exec bits survive.
      const { mode } = await lstat(full);
      const attrs = ((mode & 0xff_ff) << 16) >>> 0;
      entries.push({ relPath, attrs, ...payload });
    }
  };

  await walk(root, "");
  entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return entries;
}

/**
 * Wrap an XCArchive directory into a deterministic normalized ZIP written to
 * `outPath`.
 *
 * Every file under `dirPath` is stored under `<dir-basename>/<relative-path>`
 * (STORE, fixed mtime, sorted for byte-stability) alongside a root
 * `.sentry-cli-metadata.txt`, mirroring the legacy CLI's `normalize_directory`.
 * Symlinks and Unix permissions are preserved (see {@link collectArchiveEntries});
 * validate the directory first with {@link validateXcarchiveDirectory}.
 *
 * File bytes are streamed from disk one entry at a time, so peak memory does not
 * scale with the archive size (a large XCArchive with dSYMs no longer risks
 * Node's ~2 GiB Buffer cap).
 *
 * Documented gap: `Assets.car` asset catalogs are not parsed into per-asset
 * images (that required native macOS frameworks), so no `ParsedAssets/` tree is
 * added — the raw `.car` is uploaded as-is.
 *
 * @param dirPath - Path to the XCArchive directory.
 * @param outPath - Destination path for the normalized wrapper ZIP.
 * @param plugin - Optional plugin identity for the metadata file.
 */
export async function normalizeBuildDirectory(
  dirPath: string,
  outPath: string,
  plugin: PipelinePlugin | null
): Promise<void> {
  const root = resolve(dirPath);
  const dirName = basename(root);

  const zip = await DeterministicZipWriter.create(outPath);
  try {
    for (const entry of await collectArchiveEntries(root)) {
      const name = `${dirName}/${entry.relPath}`;
      const options = { os: ZIP_OS_UNIX, attrs: entry.attrs };
      if ("sourcePath" in entry) {
        await zip.addFile(name, entry.sourcePath, options);
      } else {
        await zip.addData(name, entry.linkTarget, options);
      }
    }
    await zip.addData(METADATA_FILENAME, strToU8(buildMetadataFile(plugin)));
    await zip.finalize();
  } catch (err) {
    await zip.close();
    throw err;
  }
}

/** Regex matching an IPA's single `Payload/<name>.app/Info.plist` entry. */
const IPA_APP_INFO_PLIST = /^Payload\/([^/]+)\.app\/Info\.plist$/;

/**
 * Extract the single app name from an IPA's entry names.
 *
 * @throws {Error} If the IPA does not contain exactly one `.app`.
 */
export function extractIpaAppName(names: string[]): string {
  const appNames = new Set<string>();
  for (const name of names) {
    const match = IPA_APP_INFO_PLIST.exec(name);
    if (match?.[1]) {
      appNames.add(match[1]);
    }
  }
  const appName = appNames.values().next().value;
  if (appNames.size !== 1 || appName === undefined) {
    throw new Error("IPA did not contain exactly one .app");
  }
  return appName;
}

/** Build the XCArchive `Info.plist` for a converted IPA. */
function xcarchiveInfoPlist(appName: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>ApplicationProperties</key>
	<dict>
		<key>ApplicationPath</key>
		<string>Applications/${appName}.app</string>
	</dict>
	<key>ArchiveVersion</key>
	<integer>1</integer>
</dict>
</plist>`;
}

/** A `Payload/…` file entry extracted from an IPA and staged on disk. */
type StagedIpaEntry = { name: string; stagePath: string };

/**
 * Stream an IPA ZIP from disk, staging every `Payload/…` file entry to a temp
 * file under `stageDir` without holding decompressed bytes in memory.
 *
 * Only file entries (not directory markers) whose name begins with `Payload/`
 * are staged; other top-level entries (e.g. `iTunesMetadata.plist`) are dropped,
 * matching the previous in-memory filter. Returns the staged entries in the
 * order they appeared in the archive (the caller sorts for determinism).
 */
async function stageIpaPayload(
  ipaPath: string,
  stageDir: string
): Promise<StagedIpaEntry[]> {
  const staged: StagedIpaEntry[] = [];
  let index = 0;

  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  unzip.onfile = (file: UnzipFile) => {
    const wanted = !file.name.endsWith("/") && file.name.startsWith("Payload/");
    if (!wanted) {
      // Still drain the entry so fflate advances past its data.
      file.ondata = () => {
        // Discard.
      };
      file.start();
      return;
    }
    const stagePath = join(stageDir, `e${index++}`);
    const fd = openSync(stagePath, "w");
    file.ondata = (err, chunk, final) => {
      if (err) {
        closeSync(fd);
        throw err;
      }
      if (chunk.length > 0) {
        writeSync(fd, chunk);
      }
      if (final) {
        closeSync(fd);
        staged.push({ name: file.name, stagePath });
      }
    };
    file.start();
  };

  const src = await open(ipaPath, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    const size = (await src.stat()).size;
    let position = 0;
    while (position < size) {
      const { bytesRead } = await src.read(buf, 0, buf.length, position);
      if (bytesRead === 0) {
        break;
      }
      position += bytesRead;
      unzip.push(
        Uint8Array.prototype.slice.call(buf, 0, bytesRead),
        position >= size
      );
    }
  } finally {
    await src.close();
  }
  return staged;
}

/**
 * Convert an IPA into a deterministic normalized XCArchive ZIP written to
 * `outPath`.
 *
 * The IPA (a ZIP of `Payload/<app>.app/…`) is remapped into an XCArchive
 * layout — `archive.xcarchive/Products/Applications/<app>.app/…` plus a
 * generated `archive.xcarchive/Info.plist` — and stored (STORE, fixed mtime)
 * alongside a root `.sentry-cli-metadata.txt`. Mirrors the legacy CLI's
 * `ipa_to_xcarchive` + `normalize_directory`.
 *
 * The IPA is stream-unzipped to temp files and stream-wrapped, so neither the
 * IPA nor the wrapper is held in memory in full.
 *
 * @param ipaPath - Path to the IPA file.
 * @param outPath - Destination path for the normalized wrapper ZIP.
 * @param plugin - Optional plugin identity for the metadata file.
 * @throws {Error} If the IPA does not contain exactly one `.app`.
 */
export async function normalizeIpa(
  ipaPath: string,
  outPath: string,
  plugin: PipelinePlugin | null
): Promise<void> {
  const stageDir = await mkdtemp(join(tmpdir(), "sentry-ipa-"));
  try {
    const staged = await stageIpaPayload(ipaPath, stageDir);
    const appName = extractIpaAppName(staged.map((e) => e.name));

    const archiveDir = "archive.xcarchive";
    // Only the identified app's entries are included (an IPA should contain
    // exactly one `.app`); a stray second bundle is ignored so it can't skew
    // size analysis.
    const appPrefix = `Payload/${appName}.app/`;

    // Remap into archive paths — a staged file for each app entry plus the
    // generated Info.plist — then sort so the output depends only on contents,
    // not on the IPA's central-directory order, keeping bytes deterministic for
    // chunk dedup across re-uploads.
    type ArchiveItem = { name: string; stagePath?: string; data?: Uint8Array };
    const items: ArchiveItem[] = [
      {
        name: `${archiveDir}/Info.plist`,
        data: strToU8(xcarchiveInfoPlist(appName)),
      },
    ];
    for (const entry of staged) {
      if (!entry.name.startsWith(appPrefix)) {
        continue;
      }
      const stripped = entry.name.slice("Payload/".length);
      // Skip path-traversal entries (a `..` segment) defensively, matching the
      // legacy CLI's `enclosed_name()` guard.
      if (stripped.split("/").includes("..")) {
        continue;
      }
      items.push({
        name: `${archiveDir}/Products/Applications/${stripped}`,
        stagePath: entry.stagePath,
      });
    }
    items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const zip = await DeterministicZipWriter.create(outPath);
    try {
      for (const item of items) {
        if (item.stagePath !== undefined) {
          await zip.addFile(item.name, item.stagePath);
        } else if (item.data !== undefined) {
          await zip.addData(item.name, item.data);
        }
      }
      await zip.addData(METADATA_FILENAME, strToU8(buildMetadataFile(plugin)));
      await zip.finalize();
    } catch (err) {
      await zip.close();
      throw err;
    }
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
}
