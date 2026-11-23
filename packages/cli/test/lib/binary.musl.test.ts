/**
 * Tests for isMusl() against simulated libc layouts. Kept in a separate file
 * so the node:child_process and node:fs mocks don't leak into binary.test.ts.
 */

import type { SpawnSyncReturns } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ldd: undefined as Partial<SpawnSyncReturns<string>> | undefined,
  hasMuslLoader: false,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:child_process")>();
  return {
    ...orig,
    spawnSync: (command: string, ...rest: unknown[]) =>
      command === "ldd"
        ? mocks.ldd
        : (orig.spawnSync as (...args: unknown[]) => unknown)(command, ...rest),
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs")>();
  return {
    ...orig,
    existsSync: (path: string) =>
      /^\/lib\/ld-musl-.+\.so\.1$/.test(path)
        ? mocks.hasMuslLoader
        : orig.existsSync(path),
  };
});

const glibcLdd = {
  status: 0,
  stdout: "ldd (GNU libc) 2.41\n",
  stderr: "",
};
const muslLdd = {
  status: 1,
  stdout: "",
  stderr: "musl libc (x86_64)\nVersion 1.2.5\n",
};
const missingLdd = {
  error: Object.assign(new Error("spawnSync ldd ENOENT"), { code: "ENOENT" }),
};

// isMusl() caches its result, so load a fresh module for each case.
async function detect(): Promise<boolean> {
  const { isMusl } = await import("../../src/lib/binary.js");
  return isMusl();
}

describe.runIf(process.platform === "linux")("isMusl", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    mocks.ldd = undefined;
    mocks.hasMuslLoader = false;
  });

  test("trusts glibc ldd over a musl loader from an installed musl package", async () => {
    mocks.ldd = glibcLdd;
    mocks.hasMuslLoader = true;
    expect(await detect()).toBe(false);
  });

  test("detects musl from ldd even though musl's ldd exits non-zero", async () => {
    mocks.ldd = muslLdd;
    expect(await detect()).toBe(true);
  });

  test("falls back to the musl loader when ldd is missing", async () => {
    mocks.ldd = missingLdd;
    mocks.hasMuslLoader = true;
    expect(await detect()).toBe(true);
  });

  test("assumes glibc when ldd and the musl loader are both missing", async () => {
    mocks.ldd = missingLdd;
    expect(await detect()).toBe(false);
  });
});
