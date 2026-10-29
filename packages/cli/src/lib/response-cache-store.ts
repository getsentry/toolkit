/**
 * Filesystem {@link CacheStore} for the CLI's response cache.
 *
 * Each entry is one JSON file, `<key>.v2.json`, written atomically. Its body
 * holds the bytes from the toolkit-core codec (zstd, or brotli on Node < 22.15)
 * as base64. A byte budget over file sizes is enforced by a cleanup sweep that
 * runs on a share of writes: it deletes expired entries, then evicts the least
 * recently used ones. A cache hit touches the file's mtime, so mtime is the
 * last use.
 *
 * Files from CLI versions before compression (`<key>.json`, with the parsed
 * JSON body inline) are still read, swept, and invalidated. They use a
 * different name so that a downgraded CLI misses new entries instead of
 * serving the encoded body as the response. When both files exist for a key,
 * the one created last is served and the other is deleted.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  type CacheEntry,
  type CacheStore,
  classifyUrl,
  FALLBACK_TTL_MS,
} from "@sentry/toolkit-core/api-client/response-cache";
import type { BodyEncoding } from "@sentry/toolkit-core/response-cache/codec";
import pLimit from "p-limit";

import { logger } from "./logger.js";

const log = logger.withTag("response-cache");

const MIB = 1024 * 1024;

/** Suffix of entries written by this version. */
const ENTRY_SUFFIX = ".v2.json";

/** Suffix of entries written before compression; also matches {@link ENTRY_SUFFIX}. */
const LEGACY_SUFFIX = ".json";

/**
 * Age (ms) after which an orphaned `.tmp` file is considered abandoned.
 *
 * A live {@link atomicWrite} writes then renames in well under a second, so
 * any `.tmp` file older than this was left by a crashed process and is safe to
 * remove. The generous threshold avoids racing a concurrent write.
 */
const STALE_TEMP_FILE_MS = 60_000;

/** Shared limiter for parallel cache file I/O. */
const cacheIO = pLimit(8);

/** An entry as this version writes it. */
type StoredEntry = Omit<CacheEntry, "body"> & {
  v: 2;
  expiresAt: number;
  body: {
    encoding: BodyEncoding;
    rawSize: number;
    dictId?: string;
    /** The encoded bytes, base64. */
    data: string;
  };
};

/** An entry as CLI versions before compression wrote it. */
type LegacyEntry = {
  policy: unknown;
  /** The response body, already parsed. */
  body: unknown;
  status: number;
  headers: Record<string, string>;
  url: string;
  /** Missing from the oldest entries, which are then never invalidated. */
  identity?: string;
  createdAt: number;
  /** Missing from the oldest entries. */
  expiresAt?: number;
};

type ParsedEntry = { entry: CacheEntry; expiresAt: number };

export type FileStoreOptions = {
  /** The cache directory. */
  dir: string;
  /** Budget over all entry files, in bytes. Defaults to 50 MiB. */
  maxBytes?: number;
  /** Largest stored (compressed) body, in bytes. Defaults to 1 MiB. */
  maxEntryBytes?: number;
  /** Largest original body, in bytes. Defaults to 32 MiB. */
  maxRawBytes?: number;
  /** Share of writes that run {@link FileStore.cleanup}. Defaults to 0.1. */
  cleanupProbability?: number;
};

export type FileStore = CacheStore & {
  /** Remove the entry under `key`, in either format. */
  delete(key: string): Promise<void>;
  /** Remove every entry. */
  clear(): Promise<void>;
  /** Delete expired entries, then evict until within the byte budget. */
  cleanup(): Promise<void>;
};

const encoder = new TextEncoder();

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/** Delete a file, ignoring one that is already gone. */
async function removeFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNotFound(error)) {
      log.debug("Failed to delete cache file", error);
    }
  }
}

/** Read a file; `undefined` when missing or unreadable. */
async function readEntryFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf-8");
  } catch (error) {
    if (!isNotFound(error)) {
      log.debug("Failed to read cache file", error);
    }
    return;
  }
}

/**
 * Write a file by renaming a unique temp file into place, so a concurrent
 * reader (such as a cleanup sweep) sees the old file or the new one, never a
 * half-written one that it would delete as corrupt.
 */
async function atomicWrite(path: string, contents: string): Promise<void> {
  const tmpPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, contents, "utf-8");
    await rename(tmpPath, path);
  } catch (error) {
    await removeFile(tmpPath);
    throw error;
  }
}

function toStored(entry: CacheEntry, expiresAt: number): StoredEntry {
  const { bytes, ...body } = entry.body;
  return {
    ...entry,
    v: 2,
    expiresAt,
    body: { ...body, data: Buffer.from(bytes).toString("base64") },
  };
}

function fromStored(stored: StoredEntry): ParsedEntry {
  const { v: _v, expiresAt, body, ...entry } = stored;
  const { data, ...encoded } = body;
  return {
    entry: {
      ...entry,
      body: { ...encoded, bytes: Buffer.from(data, "base64") },
    },
    expiresAt,
  };
}

function legacyExpiresAt(legacy: LegacyEntry): number {
  return (
    legacy.expiresAt ??
    legacy.createdAt + FALLBACK_TTL_MS[classifyUrl(legacy.url ?? "")]
  );
}

function fromLegacy(legacy: LegacyEntry): ParsedEntry {
  const bytes = encoder.encode(JSON.stringify(legacy.body));
  return {
    entry: {
      url: legacy.url,
      identity: legacy.identity ?? "",
      tier: classifyUrl(legacy.url),
      status: legacy.status,
      headers: legacy.headers,
      body: { bytes, encoding: "identity", rawSize: bytes.byteLength },
      policy: legacy.policy,
      createdAt: legacy.createdAt,
    },
    expiresAt: legacyExpiresAt(legacy),
  };
}

function isStored(parsed: StoredEntry | LegacyEntry): parsed is StoredEntry {
  return "v" in parsed && parsed.v === 2;
}

/** @throws {SyntaxError} If the file is not JSON */
function parseEntry(raw: string): ParsedEntry {
  const parsed = JSON.parse(raw) as StoredEntry | LegacyEntry;
  return isStored(parsed) ? fromStored(parsed) : fromLegacy(parsed);
}

/** When a file in either format expires; `undefined` if it is not JSON. */
function parseExpiresAt(raw: string): number | undefined {
  try {
    const parsed = JSON.parse(raw) as StoredEntry | LegacyEntry;
    return isStored(parsed) ? parsed.expiresAt : legacyExpiresAt(parsed);
  } catch (error) {
    log.debug("Found a corrupt cache file", error);
    return;
  }
}

/** An entry file and its contents; `undefined` if missing or unreadable. */
async function readCandidate(
  path: string,
): Promise<{ path: string; parsed: ParsedEntry } | undefined> {
  const raw = await readEntryFile(path);
  if (raw === undefined) {
    return;
  }
  try {
    return { path, parsed: parseEntry(raw) };
  } catch (error) {
    log.debug("Deleting corrupt cache file", error);
    await removeFile(path);
    return;
  }
}

/** A cache file as the cleanup sweep sees it. */
type FileInfo = {
  file: string;
  size: number;
  lastUsed: number;
  expired: boolean;
};

/**
 * Create a store over `options.dir`. Entries over a size limit are not
 * written, and replace (remove) any entry already under their key.
 */
export function createFileStore(options: FileStoreOptions): FileStore {
  const { dir } = options;
  const maxBytes = options.maxBytes ?? 50 * MIB;
  const maxEntryBytes = options.maxEntryBytes ?? MIB;
  const maxRawBytes = options.maxRawBytes ?? 32 * MIB;
  const cleanupProbability = options.cleanupProbability ?? 0.1;

  async function sweepTempFiles(files: string[]): Promise<void> {
    const cutoff = Date.now() - STALE_TEMP_FILE_MS;
    await cacheIO.map(files, async (file) => {
      const path = join(dir, file);
      try {
        if ((await stat(path)).mtimeMs < cutoff) {
          await removeFile(path);
        }
      } catch (error) {
        log.debug("Failed to inspect cache temp file during sweep", error);
      }
    });
  }

  async function inspect(
    file: string,
    now: number,
  ): Promise<FileInfo | undefined> {
    const path = join(dir, file);
    // Read and parse separately: a read can fail transiently (locking, an AV
    // scanner, a concurrent sweep), but a file that reads fully and does not
    // parse is corrupt, since writes are atomic.
    let raw: string;
    let lastUsed: number;
    try {
      lastUsed = (await stat(path)).mtimeMs;
      raw = await readFile(path, "utf-8");
    } catch (error) {
      log.debug("Skipping unreadable cache file during sweep", error);
      return;
    }
    const expiresAt = parseExpiresAt(raw);
    return {
      file,
      size: Buffer.byteLength(raw),
      lastUsed,
      expired: expiresAt === undefined || now >= expiresAt,
    };
  }

  async function cleanup(): Promise<void> {
    let files: string[];
    try {
      files = await readdir(dir);
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw error;
    }

    // Swept even when there are no entries, so leaked temp files never pile up.
    await sweepTempFiles(files.filter((f) => f.endsWith(".tmp")));

    const now = Date.now();
    const infos = (
      await cacheIO.map(
        files.filter((f) => f.endsWith(LEGACY_SUFFIX)),
        (file) => inspect(file, now),
      )
    ).filter((info) => info !== undefined);

    const doomed = infos.filter((info) => info.expired);
    const live = infos
      .filter((info) => !info.expired)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    let total = live.reduce((sum, info) => sum + info.size, 0);
    for (const info of live) {
      if (total <= maxBytes) {
        break;
      }
      doomed.push(info);
      total -= info.size;
    }

    await cacheIO.map(doomed, (info) => removeFile(join(dir, info.file)));
  }

  return {
    async get(key) {
      // Both formats can exist: a downgraded CLI writes `<key>.json` next to
      // this version's file. Serve whichever was written last.
      const candidates = await Promise.all(
        [ENTRY_SUFFIX, LEGACY_SUFFIX].map((suffix) =>
          readCandidate(join(dir, `${key}${suffix}`)),
        ),
      );
      const [newest, older] = candidates
        .filter((candidate) => candidate !== undefined)
        .sort((a, b) => b.parsed.entry.createdAt - a.parsed.entry.createdAt);
      if (older) {
        await removeFile(older.path);
      }
      if (!newest) {
        return;
      }
      const now = Date.now();
      if (now >= newest.parsed.expiresAt) {
        return;
      }

      // Mark as recently used for eviction; a failure only skews LRU order.
      try {
        const used = new Date(now);
        await utimes(newest.path, used, used);
      } catch (error) {
        log.debug("Failed to touch cache file", error);
      }
      return newest.parsed.entry;
    },

    async set(key, entry, ttlMs) {
      const path = join(dir, `${key}${ENTRY_SUFFIX}`);
      // Any old-format copy is superseded either way.
      await removeFile(join(dir, `${key}${LEGACY_SUFFIX}`));
      if (
        !(ttlMs > 0) ||
        entry.body.bytes.byteLength > maxEntryBytes ||
        entry.body.rawSize > maxRawBytes
      ) {
        await removeFile(path);
        return;
      }

      const contents = JSON.stringify(toStored(entry, Date.now() + ttlMs));
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await atomicWrite(path, contents);

      if (Math.random() < cleanupProbability) {
        cleanup().catch((error) => {
          log.debug("Response cache cleanup failed", error);
        });
      }
    },

    async deleteMatching(identity, urlPrefix) {
      let files: string[];
      try {
        files = await readdir(dir);
      } catch (error) {
        if (!isNotFound(error)) {
          log.debug("Failed to list the response cache", error);
        }
        return;
      }

      await cacheIO.map(
        files.filter((f) => f.endsWith(LEGACY_SUFFIX)),
        async (file) => {
          const path = join(dir, file);
          const raw = await readEntryFile(path);
          if (raw === undefined) {
            return;
          }
          try {
            // Both formats keep `identity` and `url` at the top level.
            const entry = JSON.parse(raw) as Partial<LegacyEntry>;
            if (
              entry.identity === identity &&
              entry.url?.startsWith(urlPrefix)
            ) {
              await removeFile(path);
            }
          } catch (error) {
            log.debug(
              "Skipping corrupt cache file; cleanup reclaims it",
              error,
            );
          }
        },
      );
    },

    async delete(key) {
      await Promise.all([
        removeFile(join(dir, `${key}${ENTRY_SUFFIX}`)),
        removeFile(join(dir, `${key}${LEGACY_SUFFIX}`)),
      ]);
    },

    async clear() {
      await rm(dir, { recursive: true, force: true });
    },

    cleanup,
  };
}
