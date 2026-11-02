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
import { setFlagsFromString } from "node:v8";
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
  type ChunkScope,
  runSeaChunk,
  type SeaChunk,
} from "../../src/lib/sea-chunk.js";

const require = createRequire(import.meta.url);

const SUFFIX = `-${process.platform}-${process.arch}.bin`;

/** A chunk that reports through `module.exports`, as an esbuild CJS bundle would. */
function chunk(source: string, buildId = "build1"): SeaChunk {
  return { name: "cli", buildId, source, filename: "dist-build/bin.js" };
}

/** A CommonJS scope, plus the exports object the chunk writes to. */
function scope(): ChunkScope & { result: Record<string, unknown> } {
  const result: Record<string, unknown> = {};
  return {
    exports: result,
    require,
    module: { exports: result } as ChunkScope["module"],
    filename: "/usr/local/bin/sentry",
    dirname: "/usr/local/bin",
    result,
  };
}

/** Run `chunk` and the exit callback it registers, like a full process run. */
function runToExit(
  value: SeaChunk,
  cacheDir: string | undefined,
): { accepted: boolean; wroteCache: boolean } {
  const exitCallbacks: (() => void)[] = [];
  const accepted = runSeaChunk(value, scope(), cacheDir, (callback) => {
    exitCallbacks.push(callback);
  });
  for (const callback of exitCallbacks) {
    callback();
  }
  return { accepted, wroteCache: exitCallbacks.length > 0 };
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
  cacheDir = join(mkdtempSync(join(tmpdir(), "sea-chunk-")), "cache", "code");
});

afterEach(() => {
  rmSync(join(cacheDir, "..", ".."), { recursive: true, force: true });
});

describe("runSeaChunk", () => {
  test("runs the chunk with the CommonJS scope it is given", () => {
    const target = scope();
    runSeaChunk(
      chunk("module.exports.seen = [__filename, __dirname, typeof require];"),
      target,
      undefined,
    );
    expect(target.result.seen).toEqual([
      "/usr/local/bin/sentry",
      "/usr/local/bin",
      "function",
    ]);
  });

  test("reports stack positions of the bundle itself, not of the wrapper", () => {
    const target = scope();
    runSeaChunk(
      chunk("module.exports.stack = new Error('x').stack;"),
      target,
      undefined,
    );
    // Where `new Error` starts in the bundle, which is what the sourcemap maps
    expect(target.result.stack).toContain("dist-build/bin.js:1:24");
  });

  test("writes a code cache on the first run and uses it on the next", () => {
    const source = "module.exports.answer = (() => 42)();";

    expect(runToExit(chunk(source), cacheDir)).toEqual({
      accepted: false,
      wroteCache: true,
    });
    expect(readdirSync(cacheDir)).toEqual([`cli-build1${SUFFIX}`]);

    expect(runToExit(chunk(source), cacheDir)).toEqual({
      accepted: true,
      wroteCache: false,
    });
  });

  test("replaces a cache V8 rejects", () => {
    const source = "module.exports.answer = 42;";
    runToExit(chunk(source), cacheDir);
    writeFileSync(join(cacheDir, `cli-build1${SUFFIX}`), "not a code cache");

    expect(runToExit(chunk(source), cacheDir)).toEqual({
      accepted: false,
      wroteCache: true,
    });
    expect(runToExit(chunk(source), cacheDir).accepted).toBe(true);
  });

  test("keeps the caches of the three newest builds", () => {
    for (const [index, buildId] of ["b1", "b2", "b3", "b4"].entries()) {
      runToExit(chunk(`module.exports.v = ${index};`, buildId), cacheDir);
      // Distinct write times, oldest first
      const time = new Date(Date.now() - (4 - index) * 1000);
      utimesSync(join(cacheDir, `cli-${buildId}${SUFFIX}`), time, time);
    }
    runToExit(chunk("module.exports.v = 4;", "b5"), cacheDir);

    expect(readdirSync(cacheDir).sort()).toEqual([
      `cli-b3${SUFFIX}`,
      `cli-b4${SUFFIX}`,
      `cli-b5${SUFFIX}`,
    ]);
  });

  test("leaves the caches of other architectures alone", () => {
    const otherArch = `cli-b0-${process.platform}-other-arch.bin`;
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, otherArch), "");
    const time = new Date(Date.now() - 10_000);
    utimesSync(join(cacheDir, otherArch), time, time);
    for (const buildId of ["b1", "b2", "b3", "b4"]) {
      runToExit(chunk("module.exports.v = 1;", buildId), cacheDir);
    }

    expect(readdirSync(cacheDir)).toContain(otherArch);
    expect(
      readdirSync(cacheDir).filter((entry) => entry.endsWith(SUFFIX)),
    ).toHaveLength(3);
  });

  test("runs without a cache when the directory cannot be written", () => {
    const file = join(cacheDir, "..", "not-a-directory");
    runToExit(chunk("module.exports.v = 1;"), cacheDir);
    writeFileSync(file, "");

    expect(() =>
      runToExit(chunk("module.exports.v = 1;"), join(file, "code")),
    ).not.toThrow();
  });

  test("resolves import() with Node's default loader", async () => {
    const target = scope();
    runSeaChunk(
      chunk("module.exports.os = import('node:os');"),
      target,
      undefined,
    );
    const os = (await target.result.os) as typeof import("node:os");
    expect(typeof os.tmpdir).toBe("function");
  });
});
