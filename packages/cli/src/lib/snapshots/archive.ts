/**
 * Snapshot archive extraction.
 *
 * Stream-extracts a downloaded snapshot ZIP (baseline images) to a local
 * directory without buffering the whole archive — or all decompressed entries —
 * in memory. Guards against path traversal (Zip Slip): entries resolving
 * outside the output directory, and absolute paths, are skipped.
 */

import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";
import { logger } from "../logger.js";

const log = logger.withTag("snapshots.extract");

/**
 * Resolve a safe on-disk destination for a ZIP entry, or `null` to skip it.
 *
 * Skips directory entries (trailing `/`) and empty names, and any entry that
 * would escape `root` (segment-aware, so `..name` is allowed) or is absolute.
 */
function safeEntryDest(root: string, name: string): string | null {
  if (!name || name.endsWith("/")) {
    return null;
  }
  const dest = resolve(root, name);
  const rel = relative(root, dest);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    log.warn(`Skipping unsafe archive entry: ${name}`);
    return null;
  }
  return dest;
}

/**
 * Stream-extract a ZIP archive to a directory.
 *
 * Entries are decompressed and written to disk as their chunks arrive rather
 * than buffering the whole archive (or all decompressed entries) at once. Peak
 * memory is bounded by the decompressed output of one source chunk plus the
 * write stream's pending backlog — not the archive size. Only stored (0) and
 * DEFLATE (8) entries are supported — the formats Sentry's snapshot archives use.
 *
 * @param chunks - The raw ZIP bytes as an async stream of chunks.
 * @param outDir - Destination directory (created if missing).
 * @returns The number of files written.
 * @throws On a malformed archive, an unsupported compression method, or a write
 *   error.
 */
export async function extractZipStream(
  chunks: AsyncIterable<Uint8Array>,
  outDir: string
): Promise<number> {
  const root = resolve(outDir);
  mkdirSync(root, { recursive: true });

  let written = 0;
  let failure: Error | null = null;
  let completed = false;
  const writes: Promise<void>[] = [];
  const openStreams: ReturnType<typeof createWriteStream>[] = [];

  const unzip = new Unzip((file) => {
    const dest = safeEntryDest(root, file.name);
    if (dest === null) {
      // A no-op handler in case fflate enables the stream without start().
      file.ondata = () => {
        // Intentionally ignore data from skipped entries.
      };
      return;
    }

    mkdirSync(dirname(dest), { recursive: true });
    const stream = createWriteStream(dest);
    openStreams.push(stream);
    // Never reject: a write error mid-loop must not become an unhandled
    // rejection (no handler is attached until Promise.all below). Record the
    // first error and resolve; it is surfaced after all writes settle.
    writes.push(
      new Promise<void>((resolveWrite) => {
        stream.on("finish", () => {
          written += 1;
          resolveWrite();
        });
        stream.on("error", (err) => {
          failure ??= err;
          resolveWrite();
        });
      })
    );

    file.ondata = (err, data, final) => {
      if (err) {
        failure ??= err;
        stream.destroy(err);
        return;
      }
      // Copy: fflate may reuse the underlying buffer after this callback.
      if (data.length > 0) {
        stream.write(Buffer.from(data));
      }
      if (final) {
        stream.end();
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);

  // Push chunks, flagging the last one by peeking one chunk ahead. Yielding to
  // the event loop between pushes lets write streams flush.
  const iterator = chunks[Symbol.asyncIterator]();
  try {
    let pushedAny = false;
    let current = await iterator.next();
    while (!current.done) {
      const chunk = current.value;
      current = await iterator.next();
      unzip.push(chunk, current.done === true);
      pushedAny = true;
    }
    if (!pushedAny) {
      unzip.push(new Uint8Array(0), true);
    }
    await Promise.all(writes);
    completed = true;
  } finally {
    // Cancel the source (e.g. the HTTP body) so a partial read doesn't leak.
    await iterator.return?.();
    // If we bailed early (e.g. unzip.push threw on a malformed archive), close
    // any still-open write streams so their file descriptors aren't leaked.
    if (!completed) {
      for (const stream of openStreams) {
        if (!stream.closed) {
          stream.destroy();
        }
      }
    }
  }

  if (failure) {
    throw failure;
  }
  return written;
}
