import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedDataVersionTag, setFlagsFromString } from "node:v8";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import {
  type ChunkBuild,
  type ChunkSource,
  canLoadChunks,
  createChunkLoader,
} from "../../src/lib/chunk-loader.js";

const require = createRequire(import.meta.url);

const PLATFORM = `${process.platform}-${process.arch}`;

/** The code cache directory of build `id` on this platform. */
function buildDirName(id: string): string {
  return `${id}-${PLATFORM}-${cachedDataVersionTag()}`;
}

/** Chunks as CommonJS sources by file name, like a SEA build's assets. */
function source(chunks: Record<string, string>): ChunkSource {
  return {
    read: (name) => {
      const content = chunks[name];
      if (content === undefined) {
        throw new Error(`No chunk ${name}`);
      }
      return content;
    },
    filename: (name) => `dist-build/${name}`,
    scope: (name) => ({
      filename: `/usr/local/lib/sentry/${name}`,
      dirname: "/usr/local/lib/sentry",
    }),
    require,
  };
}

function build(chunks: Record<string, string>, id = "build1"): ChunkBuild {
  return { id, chunks: Object.keys(chunks) };
}

/**
 * Load `entry` of `chunks` and run the exit callbacks it registers, like a
 * full process run.
 */
function runToExit(
  chunks: Record<string, string>,
  cacheDir: string | undefined,
  id = "build1",
): { exports: unknown; wroteCache: boolean } {
  const exitCallbacks: (() => void)[] = [];
  const load = createChunkLoader(
    build(chunks, id),
    source(chunks),
    cacheDir,
    (callback) => {
      exitCallbacks.push(callback);
    },
  );
  const exports = load("cli.cjs");
  for (const callback of exitCallbacks) {
    callback();
  }
  return { exports, wroteCache: exitCallbacks.length > 0 };
}

let cacheDir: string;

beforeAll(() => {
  // Each run stands for a new process. Without this, V8 reuses the script it
  // compiled earlier in this process and ignores the code cache entirely.
  setFlagsFromString("--no-compilation-cache");
});

afterAll(() => {
  // The worker process runs other test files next
  setFlagsFromString("--compilation-cache");
});

beforeEach(() => {
  cacheDir = join(
    mkdtempSync(join(tmpdir(), "chunk-loader-")),
    "cache",
    "code",
  );
});

afterEach(() => {
  rmSync(join(cacheDir, "..", ".."), { recursive: true, force: true });
});

describe("createChunkLoader", () => {
  test("needs Node 22 or later", () => {
    // `engines.node` allows Node 20, but CI and development use newer
    expect(canLoadChunks()).toBe(true);
    // Node 20 drops `import()` from scripts compiled from a code cache
    expect(canLoadChunks({ ...process.versions, node: "20.20.2" })).toBe(false);
  });

  test("does not run on Bun", () => {
    // Bun reports Node 24 but has no `cachedDataVersionTag`
    expect(
      canLoadChunks({ ...process.versions, node: "24.3.0", bun: "1.3.14" }),
    ).toBe(false);
  });

  test("runs a chunk with the CommonJS scope its source gives it", () => {
    const { exports } = runToExit(
      {
        "cli.cjs":
          "exports.seen = [__filename, __dirname, typeof require('node:os').tmpdir];",
      },
      undefined,
    );
    expect(exports).toEqual({
      seen: [
        "/usr/local/lib/sentry/cli.cjs",
        "/usr/local/lib/sentry",
        "function",
      ],
    });
  });

  test("loads the chunks a chunk requires once, by file name", () => {
    const { exports } = runToExit(
      {
        "cli.cjs":
          "const a = require('./chunk-A.cjs'); const b = require('./chunk-B.cjs'); exports.same = a.shared === b.shared; exports.runs = a.runs();",
        "chunk-A.cjs":
          "exports.shared = require('./chunk-shared.cjs'); exports.runs = () => exports.shared.runs;",
        "chunk-B.cjs": "exports.shared = require('./chunk-shared.cjs');",
        "chunk-shared.cjs":
          "globalThis.__chunkLoaderRuns = (globalThis.__chunkLoaderRuns ?? 0) + 1; exports.runs = globalThis.__chunkLoaderRuns;",
      },
      undefined,
    );
    expect(exports).toEqual({ same: true, runs: 1 });
    delete (globalThis as { __chunkLoaderRuns?: number }).__chunkLoaderRuns;
  });

  test("reports stack positions of the chunk itself, not of the wrapper", () => {
    const { exports } = runToExit(
      { "cli.cjs": "exports.stack = new Error('x').stack;" },
      undefined,
    );
    // Where `new Error` starts in the chunk (1-based), which the sourcemap maps
    expect((exports as { stack: string }).stack).toContain(
      "dist-build/cli.cjs:1:17",
    );
  });

  test("runs a chunk that threw again on the next require", () => {
    const chunks = {
      "cli.cjs": "exports.v = 1;",
      "chunk-A.cjs":
        "globalThis.__chunkLoaderThrow = (globalThis.__chunkLoaderThrow ?? 0) + 1; if (globalThis.__chunkLoaderThrow === 1) throw new Error('first');",
    };
    const load = createChunkLoader(build(chunks), source(chunks), undefined);
    expect(() => load("chunk-A.cjs")).toThrow("first");
    expect(() => load("chunk-A.cjs")).not.toThrow();
    delete (globalThis as { __chunkLoaderThrow?: number }).__chunkLoaderThrow;
  });

  test("writes a code cache on the first run and uses it on the next", () => {
    const chunks = {
      "cli.cjs": "exports.answer = require('./chunk-A.cjs').answer;",
      "chunk-A.cjs": "exports.answer = (() => 42)();",
    };

    expect(runToExit(chunks, cacheDir)).toEqual({
      exports: { answer: 42 },
      wroteCache: true,
    });
    expect(readdirSync(cacheDir)).toEqual([buildDirName("build1")]);
    expect(readdirSync(join(cacheDir, buildDirName("build1"))).sort()).toEqual([
      "chunk-A.cjs.bin",
      "cli.cjs.bin",
    ]);

    expect(runToExit(chunks, cacheDir).wroteCache).toBe(false);
  });

  test("writes the caches of the chunks a later run loads first", () => {
    const chunks = {
      "cli.cjs":
        "exports.load = () => require('./chunk-A.cjs'); if (process.env.__CHUNK_LOADER_A === '1') exports.load();",
      "chunk-A.cjs": "exports.v = 1;",
    };
    runToExit(chunks, cacheDir);
    process.env.__CHUNK_LOADER_A = "1";
    try {
      expect(runToExit(chunks, cacheDir).wroteCache).toBe(true);
      expect(runToExit(chunks, cacheDir).wroteCache).toBe(false);
    } finally {
      delete process.env.__CHUNK_LOADER_A;
    }
  });

  test("replaces a cache V8 rejects", () => {
    const chunks = { "cli.cjs": "exports.answer = 42;" };
    runToExit(chunks, cacheDir);
    writeFileSync(
      join(cacheDir, buildDirName("build1"), "cli.cjs.bin"),
      "not a code cache",
    );

    expect(runToExit(chunks, cacheDir).wroteCache).toBe(true);
    expect(runToExit(chunks, cacheDir).wroteCache).toBe(false);
  });

  test("keeps the caches of the three newest builds", () => {
    for (const [index, id] of ["b1", "b2", "b3", "b4"].entries()) {
      runToExit({ "cli.cjs": `exports.v = ${index};` }, cacheDir, id);
      // Distinct write times, oldest first
      const time = new Date(Date.now() - (4 - index) * 1000);
      utimesSync(join(cacheDir, buildDirName(id)), time, time);
    }
    runToExit({ "cli.cjs": "exports.v = 4;" }, cacheDir, "b5");

    expect(readdirSync(cacheDir).sort()).toEqual(
      ["b3", "b4", "b5"].map(buildDirName),
    );
  });

  test("leaves the caches of other architectures alone", () => {
    const otherArch = `b0-${process.platform}-other-arch-1`;
    mkdirSync(join(cacheDir, otherArch), { recursive: true });
    const time = new Date(Date.now() - 10_000);
    utimesSync(join(cacheDir, otherArch), time, time);
    for (const id of ["b1", "b2", "b3", "b4"]) {
      runToExit({ "cli.cjs": "exports.v = 1;" }, cacheDir, id);
    }

    expect(readdirSync(cacheDir)).toContain(otherArch);
    expect(
      readdirSync(cacheDir).filter((entry) => entry.includes(PLATFORM)),
    ).toHaveLength(3);
  });

  test("deletes the cache files of earlier releases", () => {
    const legacy = `cli-0123456789abcdef-${PLATFORM}.bin`;
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, legacy), "");

    runToExit({ "cli.cjs": "exports.v = 1;" }, cacheDir);

    expect(readdirSync(cacheDir)).toEqual([buildDirName("build1")]);
  });

  test("runs without a cache when the directory cannot be written", () => {
    const file = join(cacheDir, "..", "not-a-directory");
    mkdirSync(join(cacheDir, ".."), { recursive: true });
    writeFileSync(file, "");

    expect(
      runToExit({ "cli.cjs": "exports.v = 1;" }, join(file, "code")).exports,
    ).toEqual({ v: 1 });
  });

  test("resolves import() with Node's default loader", async () => {
    const { exports } = runToExit(
      { "cli.cjs": "exports.os = import('node:os');" },
      undefined,
    );
    const os = (await (exports as { os: Promise<typeof import("node:os")> })
      .os) as typeof import("node:os");
    expect(typeof os.tmpdir).toBe("function");
  });

  test("resolves import() in a chunk compiled from its code cache", async () => {
    const chunks = {
      "cli.cjs": "exports.os = () => import('node:os');",
    };
    runToExit(chunks, cacheDir);
    const { exports, wroteCache } = runToExit(chunks, cacheDir);

    expect(wroteCache).toBe(false);
    const os = await (
      exports as { os: () => Promise<typeof import("node:os")> }
    ).os();
    expect(typeof os.tmpdir).toBe("function");
  });
});
