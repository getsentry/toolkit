/**
 * Tests for the read-only sourcemap resolution pass that powers
 * `sentry sourcemap resolve`. Verifies companion-map detection,
 * sourceMappingURL classification (external / inline / remote / missing),
 * and debug-ID extraction.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolveDirectorySourcemaps } from "../../../src/lib/sourcemap/inject.js";

describe("resolveDirectorySourcemaps", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sentry-resolve-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(rel: string, content: string): void {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }

  test("resolves a convention-named companion map", async () => {
    write("app.js", "console.log(1)\n");
    write("app.js.map", "{}\n");

    const results = await resolveDirectorySourcemaps(dir);
    expect(results).toHaveLength(1);
    expect(results[0]?.mapPath).toBe(join(dir, "app.js.map"));
    expect(results[0]?.inline).toBe(false);
    expect(results[0]?.remote).toBe(false);
  });

  test("reports a JS file with no companion map", async () => {
    write("orphan.js", "console.log(1)\n");

    const results = await resolveDirectorySourcemaps(dir);
    expect(results).toHaveLength(1);
    expect(results[0]?.mapPath).toBeUndefined();
    expect(results[0]?.sourceMappingUrl).toBeUndefined();
  });

  test("classifies an inline data: sourceMappingURL", async () => {
    write(
      "inline.js",
      "console.log(1)\n//# sourceMappingURL=data:application/json;base64,e30=\n"
    );

    const results = await resolveDirectorySourcemaps(dir);
    expect(results).toHaveLength(1);
    expect(results[0]?.inline).toBe(true);
    expect(results[0]?.mapPath).toBeUndefined();
  });

  test("classifies a remote sourceMappingURL", async () => {
    write(
      "remote.js",
      "console.log(1)\n//# sourceMappingURL=https://cdn.example.com/remote.js.map\n"
    );

    const results = await resolveDirectorySourcemaps(dir);
    expect(results[0]?.remote).toBe(true);
    expect(results[0]?.mapPath).toBeUndefined();
  });

  test("extracts an injected debug ID", async () => {
    const debugId = "a1b2c3d4-e5f6-4789-abcd-ef0123456789";
    write("with-id.js", `console.log(1)\n//# debugId=${debugId}\n`);
    write("with-id.js.map", "{}\n");

    const results = await resolveDirectorySourcemaps(dir);
    expect(results[0]?.debugId).toBe(debugId);
  });

  test("reports undefined debug ID when not injected", async () => {
    write("plain.js", "console.log(1)\n");
    write("plain.js.map", "{}\n");

    const results = await resolveDirectorySourcemaps(dir);
    expect(results[0]?.debugId).toBeUndefined();
  });

  test("results are sorted by path", async () => {
    write("b.js", "1\n");
    write("a.js", "1\n");
    write("c.js", "1\n");

    const results = await resolveDirectorySourcemaps(dir);
    const names = results.map((r) => r.jsPath);
    // Byte-wise sort, matching resolveDirectorySourcemaps' path ordering.
    expect(names).toEqual([...names].sort());
  });
});
