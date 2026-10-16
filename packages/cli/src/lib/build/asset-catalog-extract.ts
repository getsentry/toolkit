/** Run the legacy CoreUI parser without buffering catalogs or decoded images. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream, existsSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  array,
  boolean,
  check,
  type InferOutput,
  integer,
  maxValue,
  minValue,
  number,
  optional,
  parse,
  picklist,
  pipe,
  regex,
  strictObject,
  string,
} from "valibot";
import { logger } from "../logger.js";
import { getSeaRawAsset } from "../sea-assets.js";

const log = logger.withTag("build.asset-catalog");
const runHelper = promisify(execFile);

/** Must always match the fossilize asset path in script/build.ts. */
export const CAR_EXTRACT_ASSET_KEY = "dist-build/car-extract";
const NATIVE_SCRIPTS_DIR = new URL("../../../native/", import.meta.url);
const DEV_HELPER_PATH = fileURLToPath(
  new URL("car-extract/.build/release/car-extract", NATIVE_SCRIPTS_DIR),
);
const MANIFEST_MAX_BYTES = 16 * 1024 * 1024;
// oxlint-disable-next-line no-bitwise -- Node copyFile flags are bit masks; combine exclusive creation with reflink fallback.
const COPY_FILE_FLAGS = constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE;
const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".heic",
  ".heif",
  ".gif",
  ".webp",
  ".pdf",
  ".svg",
  ".tiff",
  ".tif",
  ".bmp",
]);

const UnsignedInteger = pipe(
  number(),
  integer(),
  minValue(0),
  maxValue(Number.MAX_SAFE_INTEGER),
);
const AssetCatalogEntrySchema = strictObject({
  imageId: pipe(
    string(),
    check((id) => id === "" || UUID_PATTERN.test(id)),
  ),
  size: UnsignedInteger,
  name: string(),
  vector: boolean(),
  width: optional(UnsignedInteger),
  height: optional(UnsignedInteger),
  filename: optional(string()),
  type: optional(picklist([0, 1, 2])),
  idiom: optional(string()),
  colorspace: optional(string()),
  contentHash: optional(pipe(string(), regex(/^[0-9a-f]{64}$/))),
  scale: optional(UnsignedInteger),
});

/** The server's legacy Assets.json contract, including its aggregate color row. */
export type AssetCatalogEntry = InferOutput<typeof AssetCatalogEntrySchema>;

/** Files stay on disk until the ZIP writer consumes them, then cleanup releases them. */
export type AssetCatalogExtraction = {
  files: { name: string; sourcePath: string }[];
  cleanup: () => Promise<void>;
};

async function cleanupDirectory(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true });
  } catch {
    // Cleanup must never turn a successful upload or a fallback into a failure.
    log.debug(
      "Could not remove the temporary asset-catalog extraction directory",
    );
  }
}

async function imageHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/** Validate every helper-generated path before opening it. Never follow a symlink. */
async function regularFile(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile()) {
      throw new Error("Asset-catalog output must be a regular file");
    }
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/** Keep UUID-shaped IDs and their sibling filenames while removing native randomness. */
function stableImageId(identity: string, occurrence: number): string {
  const digest = createHash("sha256")
    .update(`${identity}\0${occurrence}`)
    .digest("hex")
    .slice(0, 32)
    .toUpperCase();
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    digest.slice(12, 16),
    digest.slice(16, 20),
    digest.slice(20),
  ].join("-");
}

/**
 * Preserve the legacy metadata and <imageId>.<original-extension> association.
 * Stable IDs, JSON key order, and entry order keep identical uploads byte-stable.
 */
async function canonicalizeOutput(
  outputDirectory: string,
  canonicalDirectory: string,
  catalogRelativePath: string,
): Promise<AssetCatalogExtraction["files"]> {
  const manifestPath = join(outputDirectory, "Assets.json");
  if (
    !(await regularFile(manifestPath)) ||
    (await lstat(manifestPath)).size > MANIFEST_MAX_BYTES
  ) {
    throw new Error("Asset-catalog manifest is missing or too large");
  }
  const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  const assets = parse(array(AssetCatalogEntrySchema), manifest);
  const seenIds = new Set<string>();
  const renditions = [];
  for (const { imageId, ...asset } of assets) {
    if (imageId && seenIds.has(imageId)) {
      throw new Error("Asset-catalog manifest contains duplicate image IDs");
    }
    seenIds.add(imageId);
    // NSString.pathExtension treats a trailing dot as an empty extension.
    const extension = `.${
      posix
        .extname(asset.filename ?? "")
        .slice(1)
        .toLowerCase() || "png"
    }`;
    const sourcePath = join(outputDirectory, `${imageId}${extension}`);
    const hasImage =
      imageId !== "" &&
      IMAGE_EXTENSIONS.has(extension) &&
      (await regularFile(sourcePath));
    const hash = hasImage ? await imageHash(sourcePath) : "";
    const identity = `${catalogRelativePath}\0${JSON.stringify(asset)}\0${hash}`;
    renditions.push({
      imageId,
      asset,
      extension,
      sourcePath,
      hasImage,
      identity,
    });
  }
  renditions.sort((a, b) =>
    a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0,
  );

  await mkdir(canonicalDirectory);
  const occurrences = new Map<string, number>();
  const canonicalAssets: AssetCatalogEntry[] = [];
  const files: AssetCatalogExtraction["files"] = [];
  for (const rendition of renditions) {
    const occurrence = occurrences.get(rendition.identity) ?? 0;
    occurrences.set(rendition.identity, occurrence + 1);
    const imageId = rendition.imageId
      ? stableImageId(rendition.identity, occurrence)
      : "";
    canonicalAssets.push({ imageId, ...rendition.asset });
    if (rendition.hasImage) {
      const name = `${imageId}${rendition.extension}`;
      const sourcePath = join(canonicalDirectory, name);
      await copyFile(rendition.sourcePath, sourcePath, COPY_FILE_FLAGS);
      files.push({ name, sourcePath });
    }
  }
  const sourcePath = join(canonicalDirectory, "Assets.json");
  await writeFile(sourcePath, `${JSON.stringify(canonicalAssets)}\n`);
  files.push({ name: "Assets.json", sourcePath });
  return files;
}

/**
 * Extract a catalog with the macOS arm64 helper. Always return null on unsupported
 * platforms or extraction failure; the caller still uploads the original catalog.
 * A successful result owns temporary disk files until its cleanup is awaited.
 */
export async function extractAssetCatalogImages(
  catalogRelativePath: string,
  catalogPath: string,
): Promise<AssetCatalogExtraction | null> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    return null;
  }
  const state: { directory?: string; retained: boolean } = { retained: false };
  try {
    // IPA entry names are untrusted. Copy only safe relative paths into our
    // private staging tree, never a caller-controlled absolute or parent path.
    if (
      catalogRelativePath.includes("\\") ||
      catalogRelativePath.includes("\0") ||
      /^[A-Za-z]:/.test(catalogRelativePath) ||
      catalogRelativePath
        .split("/")
        .some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error("Invalid archive-relative asset-catalog path");
    }
    const embeddedHelper = getSeaRawAsset(CAR_EXTRACT_ASSET_KEY);
    if (!embeddedHelper && !existsSync(DEV_HELPER_PATH)) {
      log.debug("Asset-catalog helper is unavailable in this runtime");
      return null;
    }
    // Temp creation, helper extraction, and cleanup all belong to this boundary.
    // Even ENOSPC or an invalid TMPDIR must preserve the upload fallback.
    const directory = await mkdtemp(join(tmpdir(), "sentry-car-"));
    state.directory = directory;
    const helperPath = embeddedHelper
      ? join(directory, "car-extract")
      : DEV_HELPER_PATH;
    if (embeddedHelper) {
      await writeFile(helperPath, embeddedHelper, { mode: 0o700, flag: "wx" });
    }
    const inputPath = join(directory, "input.xcarchive", catalogRelativePath);
    await mkdir(posix.dirname(inputPath), { recursive: true });
    await copyFile(catalogPath, inputPath, COPY_FILE_FLAGS);
    const outputRoot = join(directory, "parsed");
    await runHelper(helperPath, [inputPath, outputRoot], {
      timeout: 300_000,
      maxBuffer: 64 * 1024,
      // Never surface native stdout/stderr: they can include catalog contents.
      env: { ...process.env, SWIFT_BACKTRACE: "enable=no" },
    });
    const files = await canonicalizeOutput(
      join(outputRoot, posix.dirname(catalogRelativePath)),
      join(directory, "canonical"),
      catalogRelativePath,
    );
    state.retained = true;
    return { files, cleanup: () => cleanupDirectory(directory) };
  } catch {
    // Child-process and parser exceptions may contain input-bearing native output.
    log.debug(
      "Asset-catalog extraction failed; uploading the original catalog unchanged",
    );
    return null;
  } finally {
    if (state.directory && !state.retained) {
      await cleanupDirectory(state.directory);
    }
  }
}
