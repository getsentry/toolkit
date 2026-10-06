/**
 * Deterministic synthetic repo generator for benchmarks.
 *
 * Given a FixtureSpec + seed, produces a reproducible on-disk tree mixing
 * text source files (with configurable DSN scatter), binary blobs, and
 * .gitignore files. Two machines running the same spec + seed produce
 * byte-identical directory trees (modulo mtimes), which is what lets us
 * compare bench numbers across contributors.
 *
 * Intentionally has zero imports from `src/` — the bench harness has to
 * be able to generate fixtures before any production code runs.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Parameters for a synthetic repo. Defaults live in `presets.ts`. */
export type FixtureSpec = {
  /** Absolute directory to populate. Created if missing. */
  rootDir: string;
  /** Monorepo package count. `0` produces a single-repo layout. */
  packages: number;
  /**
   * Text + binary files to generate per package (or total files when
   * `packages` is 0). Actual count lands within ±3% of this target.
   */
  filesPerPackage: number;
  /** Text file extensions. Picked round-robin; DSN sprinkling works across all. */
  fileExtensions: string[];
  /**
   * Binary file extensions — picked for each binary blob. Defaults
   * to `[".bin"]` for backward compat with pre-existing fixture
   * hashes. Real-world shapes use a mix (`.png`, `.woff2`, `.mp3`,
   * `.pdf`, etc.) to exercise the `BINARY_EXTENSIONS` fast-path in
   * `src/lib/scan/binary.ts`.
   */
  binaryExtensions?: string[];
  /** Fraction [0,1] of files that are random binary blobs (NUL-byte-containing). */
  binaryRatio: number;
  /** Fraction [0,1] of text files that include a DSN somewhere in the body. */
  dsnRatio: number;
  /** Gitignore strategy. `"nested"` drops one per package directory. */
  gitignoreDepth: "root" | "nested";
  /** Mean file size in KB. Actual sizes drawn from a lognormal-ish distribution. */
  avgFileKB: number;
  /** Deterministic PRNG seed. Same seed = same tree. */
  seed: number;
  /**
   * Max subdirectory depth below the root (or package root in monorepo mode).
   * Files are scattered across `src/{sub}/...` up to this depth.
   */
  subdirDepth: number;
};

/** Metadata written to `.meta.json` inside the fixture root. */
export type FixtureMeta = {
  /** Schema version for forward compat. Bumped on breaking generator changes. */
  version: 1;
  spec: Omit<FixtureSpec, "rootDir">;
  /** Total file count (text + binary). Reported by the generator. */
  fileCount: number;
  /** Count of text files that had a DSN placed inside them. */
  dsnCount: number;
  /** Generated timestamp (Unix ms). */
  generatedAt: number;
};

/**
 * Pseudo-random number generator with a single 32-bit state.
 *
 * Uses xorshift32, which is fast, has a period > 4 billion, and is
 * plenty for fixture generation. The `next()` method returns a float
 * in [0, 1) matching Math.random()'s contract.
 *
 * Note: the biome rule against bitwise operators is intentionally
 * suppressed for this class. Xorshift's defining property is the
 * bitwise xor/shift sequence; rewriting with arithmetic would change
 * the output (and the "reproducible trees" property).
 */
// biome-ignore-start lint/suspicious/noBitwiseOperators: xorshift32 requires bitwise ops
class XorShift32 {
  private state: number;

  constructor(seed: number) {
    // Ensure seed is non-zero (xorshift degenerates at 0).
    const coerced = seed | 0;
    this.state = coerced === 0 ? 1 : coerced;
  }

  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x | 0;
    // Convert to [0, 1) by dividing by 2^32.
    return (x >>> 0) / 4_294_967_296;
  }

  /** Integer in [0, max). */
  int(max: number): number {
    return Math.floor(this.next() * max);
  }

  /** Pick one element from `arr`. */
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)] as T;
  }

  /** Boolean true with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }
}
// biome-ignore-end lint/suspicious/noBitwiseOperators: xorshift32 requires bitwise ops

/** Synthetic DSN templates scattered throughout text files. */
const DSN_TEMPLATES = [
  "https://abc123def456abc123def456abc123de@o123456.ingest.us.sentry.io/4507654321",
  "https://f00ba7f00ba7f00ba7f00ba7f00ba7f0@o987654.ingest.de.sentry.io/1234567890",
  "https://deadbeefdeadbeefdeadbeefdeadbeef@o555555.ingest.us.sentry.io/9999999",
  "https://cafed00dcafed00dcafed00dcafed00d@o111222.ingest.us.sentry.io/7654321",
] as const;

/** Pool of boring filler line snippets — kept plain ASCII to simplify sizing. */
const FILLER_LINES = [
  "const value = computeSomething(input);",
  "if (result === null) { return fallback; }",
  "// regular comment about the implementation",
  "function doWork(input: string): string { return input.trim(); }",
  "import { something } from './module.js';",
  "const pattern = /foo(bar)?/gi;",
  "export type Thing = { id: string; name: string; };",
  "throw new Error('unexpected state');",
  "// TODO: revisit this after the refactor",
  "return cache.get(key) ?? fallback();",
] as const;

/** Typical root-level .gitignore contents (simulates a real repo). */
const ROOT_GITIGNORE = `# bench fixture gitignore
node_modules/
dist/
build/
.cache/
coverage/
*.log
`;

/** Per-package .gitignore (adds some package-local patterns). */
const PACKAGE_GITIGNORE = `# package-local ignores
.build/
out/
*.generated.ts
`;

/**
 * Generate a fixture if one doesn't already exist with the same spec.
 *
 * The generator writes a `.meta.json` file into the fixture root containing
 * a content-hash of the spec. On a second invocation with the same spec,
 * the function short-circuits — this is what makes `bun run bench` fast
 * on repeat invocations.
 *
 * When `force: true`, any existing fixture is wiped and re-generated.
 *
 * @returns Metadata describing the generated fixture.
 */
export function generateFixture(
  spec: FixtureSpec,
  options: { force?: boolean } = {}
): FixtureMeta {
  const existing = readMeta(spec.rootDir);
  if (!options.force && existing && specMatches(existing.spec, spec)) {
    return existing;
  }

  // Start fresh — `mkdirSync(recursive)` is cheap and tolerates existing dirs,
  // but we don't rm here because the caller owns the directory lifecycle.
  mkdirSync(spec.rootDir, { recursive: true });

  const rng = new XorShift32(spec.seed);
  let fileCount = 0;
  let dsnCount = 0;

  // Always seed a root .gitignore so walkers honor it regardless of strategy.
  writeFileSync(join(spec.rootDir, ".gitignore"), ROOT_GITIGNORE, "utf8");
  // An empty `.git` directory makes the fixture a definitive project root.
  // Without this, `findProjectRoot` would walk up into the real repo and
  // resolve the bench numbers there instead — polluting both the timing
  // and the DSN results.
  mkdirSync(join(spec.rootDir, ".git"), { recursive: true });
  // A node_modules/ dir that should be fully skipped — sanity check for ignore logic.
  mkdirSync(join(spec.rootDir, "node_modules", "some-pkg"), {
    recursive: true,
  });
  writeFileSync(
    join(spec.rootDir, "node_modules", "some-pkg", "index.js"),
    "// should never be scanned\n",
    "utf8"
  );

  if (spec.packages === 0) {
    const result = populatePackage(spec.rootDir, spec, rng, {
      includeNested: false,
    });
    fileCount += result.fileCount;
    dsnCount += result.dsnCount;
  } else {
    // Pick a monorepo root name deterministically per seed to simulate real layouts.
    const monorepoRoots = ["packages", "apps", "libs"] as const;
    const monorepoRoot = monorepoRoots[
      spec.seed % monorepoRoots.length
    ] as string;
    for (let i = 0; i < spec.packages; i += 1) {
      const pkgDir = join(
        spec.rootDir,
        monorepoRoot,
        `pkg-${i.toString().padStart(3, "0")}`
      );
      mkdirSync(pkgDir, { recursive: true });
      if (spec.gitignoreDepth === "nested") {
        writeFileSync(join(pkgDir, ".gitignore"), PACKAGE_GITIGNORE, "utf8");
      }
      const result = populatePackage(pkgDir, spec, rng, {
        includeNested: spec.gitignoreDepth === "nested",
      });
      fileCount += result.fileCount;
      dsnCount += result.dsnCount;
    }
  }

  const meta: FixtureMeta = {
    version: 1,
    spec: stripRootDir(spec),
    fileCount,
    dsnCount,
    generatedAt: Date.now(),
  };
  writeFileSync(
    join(spec.rootDir, ".meta.json"),
    JSON.stringify(meta, null, 2),
    "utf8"
  );
  return meta;
}

/** Populate a single package (or the whole repo when `packages === 0`). */
function populatePackage(
  baseDir: string,
  spec: FixtureSpec,
  rng: XorShift32,
  _opts: { includeNested: boolean }
): { fileCount: number; dsnCount: number } {
  const targetFiles = spec.filesPerPackage;
  const textCount = Math.max(
    1,
    Math.round(targetFiles * (1 - spec.binaryRatio))
  );
  const binaryCount = Math.max(0, targetFiles - textCount);

  const srcDir = join(baseDir, "src");
  mkdirSync(srcDir, { recursive: true });

  let fileCount = 0;
  let dsnCount = 0;

  for (let i = 0; i < textCount; i += 1) {
    const depth = 1 + rng.int(Math.max(1, spec.subdirDepth));
    const subdir = pickSubdir(srcDir, depth, rng);
    mkdirSync(subdir, { recursive: true });
    const ext = rng.pick(spec.fileExtensions);
    const filename = `file-${i.toString().padStart(4, "0")}${ext}`;
    const includeDsn = rng.chance(spec.dsnRatio);
    const content = buildTextFileContent(spec.avgFileKB, includeDsn, rng);
    writeFileSync(join(subdir, filename), content, "utf8");
    fileCount += 1;
    if (includeDsn) {
      dsnCount += 1;
    }
  }

  // `assets/` is intentionally a sibling of `src/` so the binary
  // blobs stay inside the walked tree (outside `src/` means the
  // walker still reaches them via the package root). Extension
  // picked from `spec.binaryExtensions` (defaults to `.bin` when
  // unspecified).
  const binaryExts = spec.binaryExtensions ?? [".bin"];
  for (let i = 0; i < binaryCount; i += 1) {
    const subdir = join(baseDir, "assets");
    mkdirSync(subdir, { recursive: true });
    const ext = rng.pick(binaryExts);
    const filename = `blob-${i.toString().padStart(4, "0")}${ext}`;
    writeFileSync(join(subdir, filename), buildBinaryBlob(spec.avgFileKB, rng));
    fileCount += 1;
  }

  return { fileCount, dsnCount };
}

/** Random subdirectory path under `base` with exactly `depth` levels below it. */
function pickSubdir(base: string, depth: number, rng: XorShift32): string {
  const pool = [
    "core",
    "utils",
    "config",
    "lib",
    "internal",
    "components",
    "api",
  ];
  let cur = base;
  for (let i = 0; i < depth; i += 1) {
    cur = join(cur, rng.pick(pool));
  }
  return cur;
}

/** Produce plausible text file contents, optionally embedding a DSN line. */
function buildTextFileContent(
  avgKB: number,
  includeDsn: boolean,
  rng: XorShift32
): string {
  // Target size varies between 0.5x–2x avgKB to simulate a lognormal-ish spread.
  const sizeKB = avgKB * (0.5 + rng.next() * 1.5);
  const targetBytes = Math.max(64, Math.round(sizeKB * 1024));
  const lines: string[] = [];
  let bytes = 0;
  if (includeDsn) {
    // Put the DSN somewhere non-commented so the DSN scanner accepts it.
    lines.push(`const SENTRY_DSN = "${rng.pick(DSN_TEMPLATES)}";`);
    bytes += lines[0].length + 1;
  }
  while (bytes < targetBytes) {
    const line = rng.pick(FILLER_LINES);
    lines.push(line);
    bytes += line.length + 1;
  }
  return `${lines.join("\n")}\n`;
}

/** Build a random binary blob of roughly avgKB size. Guaranteed to contain NUL bytes. */
function buildBinaryBlob(avgKB: number, rng: XorShift32): Uint8Array {
  const sizeKB = avgKB * (0.5 + rng.next() * 1.5);
  const bytes = Math.max(64, Math.round(sizeKB * 1024));
  const buf = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i += 1) {
    // ~1 in 200 bytes is a NUL; rest is arbitrary.
    buf[i] = rng.int(256);
    if (rng.chance(0.005)) {
      buf[i] = 0;
    }
  }
  // Force at least one NUL at a known offset so detection never false-negatives.
  buf[16] = 0;
  return buf;
}

/** Read existing `.meta.json`, returning undefined if missing or unreadable. */
function readMeta(rootDir: string): FixtureMeta | undefined {
  try {
    const raw = readFileSync(join(rootDir, ".meta.json"), "utf8");
    return JSON.parse(raw) as FixtureMeta;
  } catch {
    return;
  }
}

/** Compare two specs excluding rootDir (which is meaningless for dedup). */
function specMatches(a: FixtureMeta["spec"], b: FixtureSpec): boolean {
  return hashSpec(a) === hashSpec(stripRootDir(b));
}

/** Stable hash of a spec — used for equality and for cache dir naming. */
export function hashSpec(spec: FixtureMeta["spec"]): string {
  const canonical = JSON.stringify({
    ...spec,
    fileExtensions: [...spec.fileExtensions].sort(),
    binaryExtensions: spec.binaryExtensions
      ? [...spec.binaryExtensions].sort()
      : undefined,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function stripRootDir(spec: FixtureSpec): FixtureMeta["spec"] {
  const { rootDir: _rootDir, ...rest } = spec;
  return rest;
}
