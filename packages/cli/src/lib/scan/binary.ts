/**
 * Binary-file detection for the scan module.
 *
 * Uses the standard NUL-byte heuristic: a file is considered binary if
 * any of its first 8 KB is 0x00. This matches rg, git, grep, and
 * file(1). It is deliberately coarse — UTF-16-encoded text is
 * misclassified as binary because its ASCII-range code units produce
 * NUL bytes; callers that care can add a UTF-16 BOM check on top.
 *
 * Two entry points:
 *
 * - `classifyByExtension` — O(1) fast path. Classifies known text
 *   and known-binary extensions without a disk read. Returns `null`
 *   when the extension is ambiguous so the caller falls through to
 *   the NUL-sniff path.
 * - `readHeadAndSniff` — opens the file, reads the first 8 KB via
 *   `fs.promises.open` + `handle.read`, runs the sniff, returns the head
 *   buffer alongside the classification.
 */

import { open } from "node:fs/promises";
import { extname } from "node:path";
import { BINARY_SNIFF_BYTES } from "./constants.js";

/**
 * Extensions that are unambiguously binary. Listed extensions
 * return `{ isBinary: true }` from `classifyByExtension` with no
 * disk read — a 60-80ms win on fixtures rich in binary blobs
 * (`.bin`, build outputs full of `.png`/`.woff2`/`.pdf`, etc.).
 *
 * Inclusion rule: only extensions whose file-format specification
 * mandates non-text content. Ambiguous cases (`.log`, `.lock`,
 * `.map`) fall through to the NUL-sniff — treating them as binary
 * would silently drop text matches they may contain. `.svg` is XML
 * text, NOT included. `.json` and `.yaml` are text, NOT included.
 */
export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  // Images (raster/bitmap)
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".tiff",
  ".tif",
  ".avif",
  ".heic",
  ".heif",
  // Fonts
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  // Archives
  ".zip",
  ".gz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  ".tar",
  ".tgz",
  ".tbz2",
  ".txz",
  // Media
  ".mp3",
  ".mp4",
  ".wav",
  ".ogg",
  ".oga",
  ".ogv",
  ".webm",
  ".flac",
  ".m4a",
  ".m4v",
  ".avi",
  ".mov",
  ".mkv",
  ".opus",
  // Documents (binary office formats)
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",
  // Executables and compiled artifacts
  // NOTE: `.obj` is deliberately EXCLUDED — it's shared with the
  // Wavefront OBJ 3D model format (plain-text ASCII), common in
  // game-dev / AR / 3D-printing repos. MSVC `.obj` outputs land in
  // `build/`/`target/` dirs which DEFAULT_SKIP_DIRS prunes anyway.
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".wasm",
  ".class",
  ".o",
  ".a",
  ".pyc",
  ".pyo",
  ".node",
  // Databases (binary-format SQLite / Access)
  ".db",
  ".sqlite",
  ".sqlite3",
  ".mdb",
  // Unambiguously-binary disk images.
  // NOTE: generic blob extensions are deliberately EXCLUDED:
  //   - `.bin`  — used for both firmware/raw data AND arbitrary
  //     text dumps; no format spec.
  //   - `.dat`  — countless text data formats use this.
  //   - `.dump` — frequently plain-text SQL (`pg_dump`, `mysqldump`
  //     default to text).
  // All three fall back to the NUL-sniff, which classifies them
  // correctly by content.
  ".iso",
  ".img",
]);

/**
 * Inspect up to 8 KB of `head` for a NUL byte.
 *
 * Empty buffers are treated as text — they correspond to zero-byte
 * files, which are conventionally text (nothing to be confused about).
 */
export function isLikelyBinary(head: Uint8Array): boolean {
  const sniffLen = Math.min(head.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < sniffLen; i += 1) {
    if (head[i] === 0) {
      return true;
    }
  }
  return false;
}

/**
 * Extension-based classification for the fast path.
 *
 * Returns `{ isBinary: false }` when the extension is a known text
 * type, `{ isBinary: true }` when it is unambiguously binary (see
 * `BINARY_EXTENSIONS`). Returns `null` for the ambiguous middle
 * ground — the caller falls through to `readHeadAndSniff`.
 *
 * This is a performance hint, not a safety guarantee: even known-
 * text extensions could in principle hold NUL bytes, and files
 * without any extension (`.sentryclirc`, `Makefile`, `README`) or
 * with unusual extensions always fall through to the NUL-sniff.
 */
export function classifyByExtension(
  absPath: string,
  textExtensions: ReadonlySet<string>
): { isBinary: boolean } | null {
  const ext = extname(absPath).toLowerCase();
  if (!ext) {
    return null;
  }
  if (textExtensions.has(ext)) {
    return { isBinary: false };
  }
  if (BINARY_EXTENSIONS.has(ext)) {
    return { isBinary: true };
  }
  return null;
}

/**
 * Open `absPath`, read up to 8 KB from offset 0, and classify.
 *
 * The returned `head` is a borrowed view of the read buffer — do NOT
 * retain it beyond the current stack frame, as the backing allocation
 * is not pooled. When the file is shorter than 8 KB, the buffer is
 * sliced to the actual number of bytes read.
 *
 * Errors are re-thrown. Callers that want to swallow fs errors should
 * wrap this in try/catch.
 */
export async function readHeadAndSniff(
  absPath: string
): Promise<{ head: Uint8Array; isBinary: boolean }> {
  const handle = await open(absPath, "r");
  try {
    const buf = new Uint8Array(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buf, 0, BINARY_SNIFF_BYTES, 0);
    const head =
      bytesRead === BINARY_SNIFF_BYTES ? buf : buf.subarray(0, bytesRead);
    return { head, isBinary: isLikelyBinary(head) };
  } finally {
    await handle.close();
  }
}
