/**
 * Filesystem cache store: byte budget, LRU eviction, size limits, and
 * entries written by CLI versions before compression.
 */

import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CacheEntry } from "@sentry/toolkit-core/api-client/response-cache";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createFileStore,
  type FileStoreOptions,
} from "../../src/lib/response-cache-store.js";

const API = "https://us.sentry.io/api/0";
const MINUTE = 60_000;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "response-cache-store-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function store(options: Omit<FileStoreOptions, "dir"> = {}) {
  return createFileStore({ dir, cleanupProbability: 0, ...options });
}

function entry(path: string, size = 100, identity = "a"): CacheEntry {
  return {
    url: `${API}${path}`,
    identity,
    tier: "stable",
    status: 200,
    headers: {},
    body: { bytes: new Uint8Array(size), encoding: "identity", rawSize: size },
    policy: {},
    createdAt: Date.now(),
  };
}

/** Set a file's last use to `secondsAgo` in the past. */
async function lastUsed(key: string, secondsAgo: number): Promise<void> {
  const at = new Date(Date.now() - secondsAgo * 1000);
  await utimes(join(dir, `${key}.v2.json`), at, at);
}

async function keys(): Promise<string[]> {
  return (await readdir(dir)).map((file) => file.split(".")[0]!).sort();
}

describe("createFileStore", () => {
  test("round-trips an entry", async () => {
    const s = store();
    const original = entry("/organizations/acme/issues/", 300);
    await s.set("k", original, MINUTE);

    const cached = await s.get("k");

    expect(cached).toEqual({
      ...original,
      body: { ...original.body, bytes: expect.any(Uint8Array) },
    });
    expect(Buffer.from(cached!.body.bytes)).toEqual(
      Buffer.from(original.body.bytes),
    );
  });

  test("evicts the least recently used entries over the byte budget", async () => {
    for (const key of ["a", "b", "c", "d"]) {
      await store().set(key, entry(`/${key}/`, 1000), MINUTE);
    }
    // Room for three and a half of these same-sized files.
    const fileSize = (await stat(join(dir, "a.v2.json"))).size;
    const s = store({ maxBytes: fileSize * 3.5 });
    await lastUsed("a", 40);
    await lastUsed("b", 30);
    await lastUsed("c", 20);
    await lastUsed("d", 10);
    // Reading `a` makes it the most recently used.
    expect(await s.get("a")).toBeDefined();

    await s.cleanup();

    expect(await keys()).toEqual(["a", "c", "d"]);
  });

  test("deletes expired entries in the sweep", async () => {
    const s = store();
    await s.set("old", entry("/old/"), 1);
    await s.set("new", entry("/new/"), MINUTE);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(await s.get("old")).toBeUndefined();
    await s.cleanup();

    expect(await keys()).toEqual(["new"]);
  });

  test("does not store a body over the per-entry cap", async () => {
    const s = store({ maxEntryBytes: 1000 });
    await s.set("k", entry("/a/", 1000), MINUTE);
    expect(await s.get("k")).toBeDefined();

    // An oversized replacement removes the older response too.
    await s.set("k", entry("/a/", 1001), MINUTE);

    expect(await s.get("k")).toBeUndefined();
    expect(await keys()).toEqual([]);
  });

  test("does not store a body whose original size is over the ceiling", async () => {
    const s = store({ maxRawBytes: 10_000 });
    const big = entry("/a/");
    await s.set(
      "k",
      { ...big, body: { ...big.body, rawSize: 10_001 } },
      MINUTE,
    );

    expect(await s.get("k")).toBeUndefined();
  });

  test("deletes and reclaims corrupt files", async () => {
    const s = store();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "bad.v2.json"), "{ not json");
    await writeFile(join(dir, "worse.json"), "");

    expect(await s.get("bad")).toBeUndefined();
    await s.cleanup();

    expect(await keys()).toEqual([]);
  });

  describe("entries from older CLI versions", () => {
    async function writeLegacy(key: string, fields: object): Promise<void> {
      await writeFile(
        join(dir, `${key}.json`),
        JSON.stringify({
          policy: {},
          body: { id: key },
          status: 200,
          headers: {},
          url: `${API}/organizations/acme/issues/${key}/`,
          identity: "a",
          createdAt: Date.now(),
          ...fields,
        }),
      );
    }

    test("serves the body as uncompressed JSON", async () => {
      await writeLegacy("old", { expiresAt: Date.now() + MINUTE });

      const cached = await store().get("old");

      expect(cached?.body.encoding).toBe("identity");
      expect(JSON.parse(Buffer.from(cached!.body.bytes).toString())).toEqual({
        id: "old",
      });
      expect(cached?.tier).toBe("volatile");
    });

    test("expire by their URL tier when they have no expiresAt", async () => {
      await writeLegacy("old", { createdAt: Date.now() - 2 * MINUTE });

      expect(await store().get("old")).toBeUndefined();
    });

    test("count toward the budget and are invalidated", async () => {
      const s = store({ maxBytes: 1 });
      await writeLegacy("old", { expiresAt: Date.now() + MINUTE });
      await writeLegacy("other", {
        expiresAt: Date.now() + MINUTE,
        identity: "b",
      });

      await s.deleteMatching("a", `${API}/organizations/acme/issues/`);
      expect(await keys()).toEqual(["other"]);

      await s.cleanup();
      expect(await keys()).toEqual([]);
    });

    test("win over an older entry under the same key", async () => {
      // A downgraded CLI wrote `<key>.json` after this version wrote `<key>.v2.json`.
      const s = store();
      await s.set(
        "k",
        { ...entry("/k/"), createdAt: Date.now() - MINUTE },
        5 * MINUTE,
      );
      await writeLegacy("k", { expiresAt: Date.now() + MINUTE });

      const cached = await s.get("k");

      expect(cached?.body.encoding).toBe("identity");
      expect(JSON.parse(Buffer.from(cached!.body.bytes).toString())).toEqual({
        id: "k",
      });
      expect(await readdir(dir)).toEqual(["k.json"]);
    });

    test("lose to a newer entry under the same key", async () => {
      const s = store();
      await s.set("k", entry("/k/"), 5 * MINUTE);
      await writeLegacy("k", {
        createdAt: Date.now() - MINUTE,
        expiresAt: Date.now() + MINUTE,
      });

      const cached = await s.get("k");

      expect(cached?.url).toBe(`${API}/k/`);
      expect(await readdir(dir)).toEqual(["k.v2.json"]);
    });

    test("hide an older entry under the same key once expired", async () => {
      const s = store();
      await s.set("k", entry("/k/"), 5 * MINUTE);
      await writeLegacy("k", {
        createdAt: Date.now() + MINUTE,
        expiresAt: Date.now() - 1,
      });

      expect(await s.get("k")).toBeUndefined();
    });
  });
});
