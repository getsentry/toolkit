/**
 * Property-Based Tests for Shell Utilities
 *
 * Uses fast-check to verify invariants that should hold for any valid input,
 * catching edge cases that hand-picked unit tests would miss.
 */

import { mkdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  asyncProperty,
  constantFrom,
  assert as fcAssert,
  property,
  uniqueArray,
} from "fast-check";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  addToPath,
  detectShellType,
  getConfigCandidates,
  getPathCommand,
  isInPath,
  type ShellType,
} from "../../src/lib/shell.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

// -- Arbitraries --

/** All valid ShellType values */
const allShellTypes: ShellType[] = [
  "bash",
  "zsh",
  "fish",
  "sh",
  "ash",
  "unknown",
];

/** Known shells that map to a named type (excludes "unknown") */
const knownShells = ["bash", "zsh", "fish", "sh", "ash"] as const;

const shellTypeArb = constantFrom(...allShellTypes);
const knownShellArb = constantFrom(...knownShells);

/** Generate directory-like path prefixes */
const pathPrefixArb = constantFrom(
  "/bin",
  "/usr/bin",
  "/usr/local/bin",
  "/home/user/.local/bin",
  "/opt/homebrew/bin",
  "/nix/store/abc123-bash-5.2/bin",
  "/snap/bin"
);

/** Generate absolute directory paths */
const directoryArb = constantFrom(
  "/home/user/.sentry/bin",
  "/home/user/.local/bin",
  "/usr/local/bin",
  "/opt/sentry/bin",
  "/home/user/bin",
  "/tmp/test/bin"
);

/** Generate home directory paths */
const homeDirArb = constantFrom(
  "/home/user",
  "/home/alice",
  "/Users/bob",
  "/root"
);

/** Generate PATH strings from a set of directories */
const pathStringArb = uniqueArray(directoryArb, {
  minLength: 1,
  maxLength: 6,
}).map((dirs) => dirs.join(":"));

// -- Tests --

describe("property: detectShellType", () => {
  test("known shells are detected regardless of path prefix", () => {
    fcAssert(
      property(pathPrefixArb, knownShellArb, (prefix, shell) => {
        const result = detectShellType(`${prefix}/${shell}`);
        expect(result).toBe(shell);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("result depends only on the basename of the path", () => {
    fcAssert(
      property(
        pathPrefixArb,
        pathPrefixArb,
        knownShellArb,
        (prefix1, prefix2, shell) => {
          expect(detectShellType(`${prefix1}/${shell}`)).toBe(
            detectShellType(`${prefix2}/${shell}`)
          );
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("always returns a valid ShellType", () => {
    fcAssert(
      property(pathPrefixArb, (prefix) => {
        // Even for unrecognized shells, should return a valid type
        const result = detectShellType(`${prefix}/xonsh`);
        expect(allShellTypes).toContain(result);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("undefined always returns 'unknown'", () => {
    expect(detectShellType(undefined)).toBe("unknown");
  });
});

describe("property: getConfigCandidates", () => {
  test("always returns a non-empty array", () => {
    fcAssert(
      property(shellTypeArb, homeDirArb, (shellType, homeDir) => {
        const candidates = getConfigCandidates(shellType, homeDir);
        expect(candidates.length).toBeGreaterThan(0);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("every path starts with the home directory", () => {
    fcAssert(
      property(shellTypeArb, homeDirArb, (shellType, homeDir) => {
        const candidates = getConfigCandidates(shellType, homeDir);
        for (const path of candidates) {
          expect(path.startsWith(homeDir)).toBe(true);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: getPathCommand", () => {
  test("always contains the directory in the output", () => {
    fcAssert(
      property(shellTypeArb, directoryArb, (shellType, dir) => {
        const cmd = getPathCommand(shellType, dir);
        expect(cmd).toContain(dir);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("directory is always quoted", () => {
    fcAssert(
      property(shellTypeArb, directoryArb, (shellType, dir) => {
        const cmd = getPathCommand(shellType, dir);
        expect(cmd).toContain(`"${dir}`);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("fish returns fish_add_path, others return export PATH=", () => {
    fcAssert(
      property(directoryArb, (dir) => {
        expect(getPathCommand("fish", dir)).toContain("fish_add_path");
        for (const shell of ["bash", "zsh", "sh", "ash", "unknown"] as const) {
          expect(getPathCommand(shell, dir)).toContain("export PATH=");
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: isInPath", () => {
  test("a directory in a PATH string is always found", () => {
    fcAssert(
      property(directoryArb, pathStringArb, (dir, pathStr) => {
        // Construct a PATH that definitely contains dir
        const fullPath = `${pathStr}:${dir}`;
        expect(isInPath(dir, fullPath)).toBe(true);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("a directory not in PATH is never found", () => {
    // Use a directory that's guaranteed not to be in our set
    const absentDir = "/this/path/is/never/in/the/set";
    fcAssert(
      property(pathStringArb, (pathStr) => {
        expect(isInPath(absentDir, pathStr)).toBe(false);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("undefined PATH always returns false", () => {
    fcAssert(
      property(directoryArb, (dir) => {
        expect(isInPath(dir, undefined)).toBe(false);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: addToPath", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(
      "/tmp",
      `shell-prop-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("idempotent: second call returns modified=false", async () => {
    let fileCounter = 0;
    const shellArb = constantFrom(...(["bash", "zsh", "fish"] as const));
    await fcAssert(
      asyncProperty(shellArb, directoryArb, async (shellType, dir) => {
        fileCounter += 1;
        const configFile = join(testDir, `.rc-${fileCounter}`);
        const first = await addToPath(configFile, dir, shellType);
        expect(first.modified).toBe(true);

        const second = await addToPath(configFile, dir, shellType);
        expect(second.modified).toBe(false);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("round-trip: file contains the path command after addToPath", async () => {
    let fileCounter = 0;
    const shellArb = constantFrom(...(["bash", "zsh", "fish"] as const));
    await fcAssert(
      asyncProperty(shellArb, directoryArb, async (shellType, dir) => {
        fileCounter += 1;
        const configFile = join(testDir, `.rc-rt-${fileCounter}`);
        await addToPath(configFile, dir, shellType);

        const content = await readFile(configFile, "utf-8");
        const expectedCmd = getPathCommand(shellType, dir);
        expect(content).toContain(expectedCmd);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
