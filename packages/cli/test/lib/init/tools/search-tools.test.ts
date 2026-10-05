/**
 * Wire-contract tests for the init-wizard `grep` / `glob` tools.
 *
 * Scope after PR #791/#PR-4: the tools are thin adapters over the
 * pure-TS `collectGrep`/`collectGlob` from `src/lib/scan/`. The scan
 * module has extensive unit + property coverage of its own; this file
 * pins the adapter-level contract:
 *
 * - The Mastra wire shape (field names, nesting, per-pattern rows).
 * - Subpath + include filter behavior — delegated to scan but
 *   exercised end-to-end via the `executeTool` entry point so a
 *   regression at the adapter layer surfaces here.
 * - The sandbox guard — `safePath` at the adapter boundary must
 *   reject paths that escape the project root.
 * - The `absolutePath` field MUST NOT appear on wire results — the
 *   adapter's job is to strip it before returning.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { executeTool } from "../../../../src/lib/init/tools/registry.js";
import type {
  ResolvedInitContext,
  ToolPayload,
} from "../../../../src/lib/init/types.js";

function makeContext(directory: string): ResolvedInitContext {
  return {
    directory,
    yes: true,
    dryRun: false,
    org: "acme",
    team: "platform",
  };
}

function makeToolPayload(payload: Omit<ToolPayload, "type">): ToolPayload {
  return {
    type: "tool",
    ...payload,
  } as ToolPayload;
}

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join("/tmp", "init-search-"));

  fs.writeFileSync(
    path.join(testDir, "app.ts"),
    'import * as Sentry from "@sentry/node";\nSentry.init({ dsn: "..." });\n'
  );
  fs.writeFileSync(
    path.join(testDir, "utils.ts"),
    "export function helper() { return 1; }\n"
  );
  fs.writeFileSync(path.join(testDir, "config.json"), "{}\n");
  fs.mkdirSync(path.join(testDir, "src"));
  fs.writeFileSync(
    path.join(testDir, "src", "index.ts"),
    'import { helper } from "./utils";\nSentry.init({});\n'
  );
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

describe("search tools", () => {
  test("supports old grep include filters and subdirectory-relative paths", async () => {
    const grepWithInclude = await executeTool(
      makeToolPayload({
        operation: "grep",
        cwd: testDir,
        params: { searches: [{ pattern: "Sentry", include: "app.*" }] },
      }),
      makeContext(testDir)
    );
    const grepSubdir = await executeTool(
      makeToolPayload({
        operation: "grep",
        cwd: testDir,
        params: { searches: [{ pattern: "helper", path: "src" }] },
      }),
      makeContext(testDir)
    );

    expect(grepWithInclude.ok).toBe(true);
    for (const match of (grepWithInclude.data as any).results[0].matches) {
      expect(match.path).toContain("app");
    }

    expect(grepSubdir.ok).toBe(true);
    for (const match of (grepSubdir.data as any).results[0].matches) {
      expect(match.path).toMatch(/^src\//);
    }
  });

  test("supports old glob multi-pattern and empty-result behavior", async () => {
    const matches = await executeTool(
      makeToolPayload({
        operation: "glob",
        cwd: testDir,
        params: { patterns: ["*.ts", "*.json"] },
      }),
      makeContext(testDir)
    );
    const empty = await executeTool(
      makeToolPayload({
        operation: "glob",
        cwd: testDir,
        params: { patterns: ["*.xyz"] },
      }),
      makeContext(testDir)
    );

    expect(matches.ok).toBe(true);
    expect((matches.data as any).results).toHaveLength(2);
    expect(
      (matches.data as any).results[0].files.length
    ).toBeGreaterThanOrEqual(2);
    expect(
      (matches.data as any).results[1].files.length
    ).toBeGreaterThanOrEqual(1);

    expect(empty.ok).toBe(true);
    expect((empty.data as any).results[0].files).toHaveLength(0);
  });

  test("rejects grep paths outside the init sandbox", async () => {
    const result = await executeTool(
      makeToolPayload({
        operation: "grep",
        cwd: testDir,
        params: { searches: [{ pattern: "test", path: "../../etc" }] },
      }),
      makeContext(testDir)
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("outside project directory");
  });

  test("grep result matches MUST NOT include absolutePath", async () => {
    // The Mastra wire contract has never exposed `absolutePath`; the
    // underlying `collectGrep` does return it on each `GrepMatch`
    // (for local callers that want to re-open the file). The adapter
    // is responsible for stripping it. A regression here would leak
    // real filesystem paths into the agent's context window.
    const result = await executeTool(
      makeToolPayload({
        operation: "grep",
        cwd: testDir,
        params: { searches: [{ pattern: "Sentry" }] },
      }),
      makeContext(testDir)
    );

    expect(result.ok).toBe(true);
    const [firstRow] = (result.data as any).results;
    expect(firstRow.matches.length).toBeGreaterThan(0);
    for (const match of firstRow.matches) {
      expect(Object.keys(match).sort()).toEqual(["line", "lineNum", "path"]);
      expect("absolutePath" in match).toBe(false);
    }
  });

  test("grep bad regex yields empty matches without crashing the payload", async () => {
    // The adapter catches `ValidationError` from `compilePattern`
    // and surfaces it as an empty per-search row, letting the
    // agent retry with a corrected pattern instead of the whole
    // payload failing. If this behavior regressed, the Mastra
    // server would see `{ok: false, error: "Invalid grep pattern…"}`
    // and almost certainly stop the wizard.
    const result = await executeTool(
      makeToolPayload({
        operation: "grep",
        cwd: testDir,
        // Unclosed paren — `new RegExp("(unclosed")` throws.
        params: { searches: [{ pattern: "(unclosed" }] },
      }),
      makeContext(testDir)
    );
    expect(result.ok).toBe(true);
    expect((result.data as any).results[0]).toEqual({
      pattern: "(unclosed",
      matches: [],
      truncated: false,
    });
  });

  test("grep caseInsensitive flag enables case-insensitive matching", async () => {
    // Regression test for the new wire field added in PR-4. The
    // default is case-sensitive (matches rg), so "SENTRY" (all-caps)
    // would normally return zero hits. With `caseInsensitive: true`
    // the search picks up `Sentry` in the sandboxed fixture.
    const caseSensitive = await executeTool(
      makeToolPayload({
        operation: "grep",
        cwd: testDir,
        params: { searches: [{ pattern: "SENTRY" }] },
      }),
      makeContext(testDir)
    );
    const caseInsensitive = await executeTool(
      makeToolPayload({
        operation: "grep",
        cwd: testDir,
        params: {
          searches: [{ pattern: "SENTRY", caseInsensitive: true }],
        },
      }),
      makeContext(testDir)
    );

    expect(caseSensitive.ok).toBe(true);
    expect((caseSensitive.data as any).results[0].matches).toHaveLength(0);
    expect(caseInsensitive.ok).toBe(true);
    expect(
      (caseInsensitive.data as any).results[0].matches.length
    ).toBeGreaterThan(0);
  });
});
