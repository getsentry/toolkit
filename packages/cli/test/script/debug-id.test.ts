/**
 * Tests for debug ID injection.
 *
 * Property-based tests verify invariants of contentToDebugId.
 * Unit tests verify the full injection round-trip including
 * idempotency, hashbang preservation, and sourcemap mutation.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert as fcAssert, property, string, uint8Array } from "fast-check";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  contentToDebugId,
  getDebugIdSnippet,
  injectDebugId,
} from "../../script/debug-id.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

// ── Property-Based Tests ────────────────────────────────────────────

/** UUID v4 regex — version nibble is 4, variant nibble is 8/9/a/b */
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("property: contentToDebugId", () => {
  test("produces valid UUID v4 format for any string input", () => {
    fcAssert(
      property(string(), (input) => {
        const uuid = contentToDebugId(input);
        expect(uuid).toMatch(UUID_V4_RE);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("produces valid UUID v4 format for any binary input", () => {
    fcAssert(
      property(uint8Array({ minLength: 0, maxLength: 1024 }), (input) => {
        const uuid = contentToDebugId(Buffer.from(input));
        expect(uuid).toMatch(UUID_V4_RE);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("is deterministic — same content always produces same UUID", () => {
    fcAssert(
      property(string(), (input) => {
        const a = contentToDebugId(input);
        const b = contentToDebugId(input);
        expect(a).toBe(b);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("different content produces different UUIDs (with high probability)", () => {
    // Generate two distinct strings and verify they produce different UUIDs
    fcAssert(
      property(string(), string(), (a, b) => {
        if (a === b) return; // Skip identical pairs
        const uuidA = contentToDebugId(a);
        const uuidB = contentToDebugId(b);
        expect(uuidA).not.toBe(uuidB);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("is always lowercase", () => {
    fcAssert(
      property(string(), (input) => {
        const uuid = contentToDebugId(input);
        expect(uuid).toBe(uuid.toLowerCase());
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

// ── Unit Tests ──────────────────────────────────────────────────────

describe("getDebugIdSnippet", () => {
  test("produces a single-line string starting with ;", () => {
    const snippet = getDebugIdSnippet("test-uuid");
    expect(snippet.startsWith(";")).toBe(true);
    expect(snippet).not.toContain("\n");
  });

  test("embeds the debug ID in the _sentryDebugIds registration", () => {
    const uuid = "a1b2c3d4-e5f6-4789-abcd-ef0123456789";
    const snippet = getDebugIdSnippet(uuid);
    expect(snippet).toContain(`e._sentryDebugIds[n]="${uuid}"`);
  });

  test("embeds the sentry-dbid identifier marker", () => {
    const uuid = "a1b2c3d4-e5f6-4789-abcd-ef0123456789";
    const snippet = getDebugIdSnippet(uuid);
    expect(snippet).toContain(`sentry-dbid-${uuid}`);
  });
});

describe("injectDebugId", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "debug-id-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("injects debug ID into JS and sourcemap files", async () => {
    const jsPath = join(tmpDir, "bundle.js");
    const mapPath = join(tmpDir, "bundle.js.map");

    await writeFile(jsPath, 'console.log("hello");\n');
    await writeFile(
      mapPath,
      JSON.stringify({
        version: 3,
        sources: ["input.ts"],
        mappings: "AAAA",
      })
    );

    const { debugId } = await injectDebugId(jsPath, mapPath);

    // Debug ID should be a valid UUID v4
    expect(debugId).toMatch(UUID_V4_RE);

    // JS file should have the snippet prepended and comment appended
    const jsResult = await readFile(jsPath, "utf-8");
    expect(jsResult).toContain(`sentry-dbid-${debugId}`);
    expect(jsResult).toContain(`//# debugId=${debugId}`);
    // Original content should still be present
    expect(jsResult).toContain('console.log("hello")');

    // Sourcemap should have debugId fields
    const mapResult = JSON.parse(await readFile(mapPath, "utf-8"));
    expect(mapResult.debugId).toBe(debugId);
    expect(mapResult.debug_id).toBe(debugId);
  });

  test("prepends one ; to sourcemap mappings", async () => {
    const jsPath = join(tmpDir, "bundle.js");
    const mapPath = join(tmpDir, "bundle.js.map");
    const originalMappings = "AAAA;BACA";

    await writeFile(jsPath, "var x = 1;\n");
    await writeFile(
      mapPath,
      JSON.stringify({
        version: 3,
        sources: ["input.ts"],
        mappings: originalMappings,
      })
    );

    await injectDebugId(jsPath, mapPath);

    const mapResult = JSON.parse(await readFile(mapPath, "utf-8"));
    expect(mapResult.mappings).toBe(`;${originalMappings}`);
  });

  test("is idempotent — second injection returns same debug ID without modifying files", async () => {
    const jsPath = join(tmpDir, "bundle.js");
    const mapPath = join(tmpDir, "bundle.js.map");

    await writeFile(jsPath, 'console.log("hello");\n');
    await writeFile(
      mapPath,
      JSON.stringify({
        version: 3,
        sources: ["input.ts"],
        mappings: "AAAA",
      })
    );

    // First injection
    const first = await injectDebugId(jsPath, mapPath);
    const jsAfterFirst = await readFile(jsPath, "utf-8");
    const mapAfterFirst = await readFile(mapPath, "utf-8");

    // Second injection — should be a no-op
    const second = await injectDebugId(jsPath, mapPath);
    const jsAfterSecond = await readFile(jsPath, "utf-8");
    const mapAfterSecond = await readFile(mapPath, "utf-8");

    expect(second.debugId).toBe(first.debugId);
    expect(jsAfterSecond).toBe(jsAfterFirst);
    expect(mapAfterSecond).toBe(mapAfterFirst);
  });

  test("preserves hashbang line at the top of JS file", async () => {
    const jsPath = join(tmpDir, "bundle.js");
    const mapPath = join(tmpDir, "bundle.js.map");

    await writeFile(jsPath, '#!/usr/bin/env node\nconsole.log("hello");\n');
    await writeFile(
      mapPath,
      JSON.stringify({
        version: 3,
        sources: ["input.ts"],
        mappings: "AAAA",
      })
    );

    const { debugId } = await injectDebugId(jsPath, mapPath);

    const jsResult = await readFile(jsPath, "utf-8");
    // Hashbang must be the very first line
    expect(jsResult.startsWith("#!/usr/bin/env node\n")).toBe(true);
    // Snippet should be on the second line
    const lines = jsResult.split("\n");
    expect(lines[0]).toBe("#!/usr/bin/env node");
    expect(lines[1]).toContain(`sentry-dbid-${debugId}`);
    // Original content should still be present
    expect(jsResult).toContain('console.log("hello")');
  });

  test("skipSnippet: true skips IIFE but still appends debugId comment and mutates sourcemap", async () => {
    const jsPath = join(tmpDir, "bundle.js");
    const mapPath = join(tmpDir, "bundle.js.map");
    const originalMappings = "AAAA;BACA";

    await writeFile(jsPath, 'console.log("hello");\n');
    await writeFile(
      mapPath,
      JSON.stringify({
        version: 3,
        sources: ["input.ts"],
        mappings: originalMappings,
      })
    );

    const { debugId } = await injectDebugId(jsPath, mapPath, {
      skipSnippet: true,
    });

    // Debug ID should be a valid UUID v4
    expect(debugId).toMatch(UUID_V4_RE);

    // JS file should NOT have the IIFE snippet
    const jsResult = await readFile(jsPath, "utf-8");
    expect(jsResult).not.toContain("sentry-dbid-");
    expect(jsResult).not.toContain("_sentryDebugIds");
    // But should have the debugId comment
    expect(jsResult).toContain(`//# debugId=${debugId}`);
    // Original content should still be present
    expect(jsResult).toContain('console.log("hello")');

    // Sourcemap should have debugId fields
    const mapResult = JSON.parse(await readFile(mapPath, "utf-8"));
    expect(mapResult.debugId).toBe(debugId);
    expect(mapResult.debug_id).toBe(debugId);
    // Mappings should NOT have the extra `;` prefix (no snippet line added)
    expect(mapResult.mappings).toBe(originalMappings);
  });

  test("skipSnippet: true is idempotent", async () => {
    const jsPath = join(tmpDir, "bundle.js");
    const mapPath = join(tmpDir, "bundle.js.map");

    await writeFile(jsPath, 'console.log("hello");\n');
    await writeFile(
      mapPath,
      JSON.stringify({
        version: 3,
        sources: ["input.ts"],
        mappings: "AAAA",
      })
    );

    const first = await injectDebugId(jsPath, mapPath, { skipSnippet: true });
    const jsAfterFirst = await readFile(jsPath, "utf-8");

    const second = await injectDebugId(jsPath, mapPath, { skipSnippet: true });
    const jsAfterSecond = await readFile(jsPath, "utf-8");

    expect(second.debugId).toBe(first.debugId);
    expect(jsAfterSecond).toBe(jsAfterFirst);
  });

  test("skipSnippet: true preserves an existing map ID without runtime registration", async () => {
    const jsPath = join(tmpDir, "bundle.js");
    const mapPath = `${jsPath}.map`;
    const debugId = "11111111-2222-5333-9444-555555555555";
    const js = 'console.log("hello");\n';
    const map = JSON.stringify({ version: 3, mappings: "AAAA", debugId });
    await writeFile(jsPath, js);
    await writeFile(mapPath, map);

    expect(await injectDebugId(jsPath, mapPath, { skipSnippet: true })).toEqual(
      {
        debugId,
        wasInjected: false,
      }
    );
    expect(await readFile(jsPath, "utf-8")).toBe(js);
    expect(await readFile(mapPath, "utf-8")).toBe(map);
  });

  test("normalizes backslashes in sourcemap sources array", async () => {
    const jsPath = join(tmpDir, "bundle.js");
    const mapPath = join(tmpDir, "bundle.js.map");

    await writeFile(jsPath, 'console.log("hello");\n');
    await writeFile(
      mapPath,
      JSON.stringify({
        version: 3,
        sources: ["src\\lib\\utils.ts", "src\\bin.ts"],
        mappings: "AAAA",
      })
    );

    await injectDebugId(jsPath, mapPath);

    const mapResult = JSON.parse(await readFile(mapPath, "utf-8"));
    expect(mapResult.sources).toEqual(["src/lib/utils.ts", "src/bin.ts"]);
  });

  test("preserves null entries in sourcemap sources array", async () => {
    const jsPath = join(tmpDir, "bundle.js");
    const mapPath = join(tmpDir, "bundle.js.map");

    await writeFile(jsPath, 'console.log("hello");\n');
    await writeFile(
      mapPath,
      JSON.stringify({
        version: 3,
        sources: [null, "src\\bin.ts", null],
        mappings: "AAAA",
      })
    );

    await injectDebugId(jsPath, mapPath);

    const mapResult = JSON.parse(await readFile(mapPath, "utf-8"));
    expect(mapResult.sources).toEqual([null, "src/bin.ts", null]);
  });

  test("preserves forward-slash sources unchanged", async () => {
    const jsPath = join(tmpDir, "bundle.js");
    const mapPath = join(tmpDir, "bundle.js.map");

    await writeFile(jsPath, 'console.log("hello");\n');
    await writeFile(
      mapPath,
      JSON.stringify({
        version: 3,
        sources: ["src/lib/utils.ts", "src/bin.ts"],
        mappings: "AAAA",
      })
    );

    await injectDebugId(jsPath, mapPath);

    const mapResult = JSON.parse(await readFile(mapPath, "utf-8"));
    expect(mapResult.sources).toEqual(["src/lib/utils.ts", "src/bin.ts"]);
  });

  test("distinct minified files with identical sourcemaps get distinct debug IDs (regression #3350)", async () => {
    // Two DIFFERENT JS chunks that share a byte-identical (empty) sourcemap —
    // the exact esbuild code-splitting scenario from getsentry/sentry-cli#3350.
    // The debug ID identifies the minified artifact, so distinct artifacts must
    // NOT collide onto a single ID.
    const jsPath1 = join(tmpDir, "a.js");
    const mapPath1 = join(tmpDir, "a.js.map");
    const jsPath2 = join(tmpDir, "b.js");
    const mapPath2 = join(tmpDir, "b.js.map");

    const emptyMap = '{"version":3,"sources":[],"names":[],"mappings":""}';

    await writeFile(jsPath1, "console.log(1)\n");
    await writeFile(mapPath1, emptyMap);
    await writeFile(jsPath2, "console.log(22)\n");
    await writeFile(mapPath2, emptyMap);

    const result1 = await injectDebugId(jsPath1, mapPath1);
    const result2 = await injectDebugId(jsPath2, mapPath2);

    // Different minified content → different debug ID, even with identical maps.
    expect(result1.debugId).not.toBe(result2.debugId);
  });

  test("byte-identical (JS, map) pairs get the same debug ID (determinism preserved)", async () => {
    // Two artifacts that are byte-identical in BOTH JS and map are genuinely
    // interchangeable, so sharing a debug ID is correct and expected.
    const jsPath1 = join(tmpDir, "a.js");
    const mapPath1 = join(tmpDir, "a.js.map");
    const jsPath2 = join(tmpDir, "b.js");
    const mapPath2 = join(tmpDir, "b.js.map");

    const jsContent = "console.log(1)\n";
    const mapContent = JSON.stringify({
      version: 3,
      sources: ["input.ts"],
      mappings: "AAAA",
    });

    await writeFile(jsPath1, jsContent);
    await writeFile(mapPath1, mapContent);
    await writeFile(jsPath2, jsContent);
    await writeFile(mapPath2, mapContent);

    const result1 = await injectDebugId(jsPath1, mapPath1);
    const result2 = await injectDebugId(jsPath2, mapPath2);

    // Identical JS + identical map → same debug ID.
    expect(result1.debugId).toBe(result2.debugId);
  });
});
