import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import {
  buildMatrix,
  buildProjects,
  findProjectsByRole,
  selectAffectedProjects,
} from "./ci-projects.mjs";

const root = resolve(import.meta.dirname, "..");

function entry(name, path, manifest = {}) {
  return { path, manifest: { name, ...manifest } };
}

describe("workspace CI selection", () => {
  it("discovers all runnable workspace projects from pnpm", () => {
    const matrix = JSON.parse(
      execFileSync(
        process.execPath,
        ["scripts/ci-projects.mjs", "--event", "push"],
        {
          cwd: root,
          encoding: "utf8",
        },
      ),
    );
    const names = matrix.include.map(({ name }) => name);
    assert.ok(names.includes("sentry-cli-docs"));
    assert.ok(names.includes("sentry"));
    assert.ok(names.includes("@sentry/mcp-core"));
    assert.ok(!names.includes("@sentry/mcp-smoke-tests"));
    assert.equal(new Set(names).size, names.length);
    const docs = matrix.include.find(({ name }) => name === "sentry-cli-docs");
    assert.equal(docs.prepare, "ci:prepare");
    const docsScripts = JSON.parse(
      readFileSync(resolve(root, "apps/cli-docs/package.json"), "utf8"),
    ).scripts;
    assert.match(docsScripts[docs.prepare], /sentry run generate:schema/);
    assert.match(docsScripts[docs.prepare], /sentry run generate:docs/);
    const cli = matrix.include.find(({ name }) => name === "sentry");
    assert.equal(cli.policy, "ci:policy");
    assert.equal(cli.e2e, "test:e2e");
    assert.equal(cli.coverage, "packages/cli/coverage/lcov.info");
    assert.equal(
      matrix.include.find(({ name }) => name === "@sentry/mcp-core").junit,
      "packages/mcp-core/tests.junit.xml",
    );
  });

  it("runs only affected projects and their transitive consumers", () => {
    const projects = buildProjects([
      entry("core", "packages/core", { scripts: { build: "tsc" } }),
      entry("server", "packages/server", {
        dependencies: { core: "workspace:*" },
        scripts: { test: "vitest run" },
      }),
      entry("docs", "apps/docs", {
        sentryCi: { dependencies: ["server"] },
        scripts: { build: "astro build" },
      }),
      entry("unrelated", "packages/unrelated", {
        scripts: { build: "tsc" },
      }),
    ]);

    assert.deepEqual(
      buildMatrix(
        selectAffectedProjects(
          projects,
          ["packages/core/index.ts"],
          "pull_request",
        ),
      ).include.map(({ name }) => name),
      ["docs", "core", "server"],
    );
    assert.deepEqual(
      buildMatrix(
        selectAffectedProjects(
          projects,
          ["packages/unrelated/index.ts"],
          "pull_request",
        ),
      ).include.map(({ name }) => name),
      ["unrelated"],
    );
  });

  it("does not run CLI projects for MCP docs and core changes", () => {
    const projects = buildProjects([
      entry("@sentry/mcp-core", "packages/mcp-core", {
        scripts: { test: "vitest run" },
      }),
      entry("@sentry/mcp-server", "packages/mcp-server", {
        dependencies: { "@sentry/mcp-core": "workspace:*" },
        scripts: { test: "vitest run" },
      }),
      entry("sentry", "packages/cli", { scripts: { test: "vitest run" } }),
      entry("sentry-cli-docs", "apps/cli-docs", {
        sentryCi: { dependencies: ["sentry"] },
        scripts: { build: "astro build" },
      }),
    ]);

    const names = (files) =>
      buildMatrix(
        selectAffectedProjects(projects, files, "pull_request"),
      ).include.map(({ name }) => name);
    assert.deepEqual(names(["docs/contributing/tool-responses.md"]), []);
    assert.deepEqual(
      names([
        "docs/contributing/tool-responses.md",
        "packages/mcp-core/src/api-client/schema.ts",
      ]),
      ["@sentry/mcp-core", "@sentry/mcp-server"],
    );
    assert.deepEqual(
      names(["docs/contributing/tool-responses.md", "pnpm-lock.yaml"]),
      ["sentry-cli-docs", "sentry", "@sentry/mcp-core", "@sentry/mcp-server"],
    );
  });

  it("runs all enabled projects for root changes and non-PR events", () => {
    const projects = buildProjects([
      entry("one", "packages/one", { scripts: { build: "tsc" } }),
      entry("two", "packages/two", { scripts: { test: "vitest run" } }),
      entry("smoke", "packages/smoke", {
        scripts: { test: "vitest run" },
        sentryCi: { enabled: false },
      }),
    ]);
    const rootFiles = execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\0")
      .filter((file) => file !== "" && !file.includes("/"));
    assert.ok(rootFiles.length > 0);
    for (const [files, event] of [
      ...rootFiles.map((file) => [[file], "pull_request"]),
      [["packages/deleted/package.json"], "pull_request"],
      [[], "push"],
      [[], "merge_group"],
    ]) {
      assert.deepEqual(
        buildMatrix(selectAffectedProjects(projects, files, event)).include.map(
          ({ name }) => name,
        ),
        ["one", "two"],
      );
    }
  });

  it("keeps a stable CI status and one dynamic job per package", () => {
    const workflow = readFileSync(
      resolve(root, ".github/workflows/test.yml"),
      "utf8",
    );
    assert.match(workflow, /merge_group:/);
    assert.match(workflow, /node scripts\/ci-projects\.mjs --event/);
    assert.match(workflow, /name: \$\{\{ matrix\.name \}\}/);
    assert.match(workflow, /if: matrix\.prepare != ''/);
    assert.match(workflow, /CHECK_SCRIPT: \$\{\{ matrix\.prepare \}\}/);
    assert.doesNotMatch(workflow, /matrix\.name == 'sentry-cli-docs'/);
    assert.match(
      workflow,
      /needs: \[discover-projects, install, quality, project, npm-runtime\]/,
    );
    assert.match(
      workflow,
      /runtime-matrix: \$\{\{ steps\.projects\.outputs\.runtime-matrix \}\}/,
    );
    assert.match(
      workflow,
      /matrix: \$\{\{ fromJSON\(needs\.discover-projects\.outputs\.runtime-matrix\) \}\}/,
    );
    assert.match(
      workflow,
      /if: needs\.discover-projects\.outputs\.runtime-count != '0'/,
    );
    assert.match(workflow, /Build and pack once on Node 22/);
    assert.match(workflow, /Validate packaged runtime on Node 20/);
    assert.match(workflow, /Validate packaged runtime on Node 22/);
    assert.match(workflow, /Validate packaged runtime on Node 24/);
    assert.match(workflow, /NODE_VERSION_20: "20\.20\.2"/);
    assert.match(workflow, /NODE_VERSION_22: "22\.23\.1"/);
    assert.match(workflow, /NODE_VERSION_24: "24\.18\.0"/);
    assert.match(workflow, /RUNTIME_RESULT.*needs\.npm-runtime\.result/);
    assert.match(workflow, /name: Verify JUnit/);
    assert.match(workflow, /name: Verify coverage/);
    assert.match(workflow, /if: always\(\)/);
    assert.doesNotMatch(workflow.split("\njobs:", 1)[0], /paths(?:-ignore)?:/);
  });

  it("requires safe metadata and a single owner of each specialized role", () => {
    assert.throws(
      () =>
        buildProjects([
          entry("service", "packages/service", {
            sentryCi: { coverage: "../secret" },
          }),
        ]),
      /safe relative path/,
    );
    assert.throws(
      () =>
        buildProjects([
          entry("service", "packages/service", {
            sentryCi: { dependencies: ["missing"] },
          }),
        ]),
      /unknown CI dependency/,
    );
    const projects = buildProjects([
      entry("worker", "packages/worker", {
        sentryCi: { roles: ["cloudflare"] },
      }),
      entry("smoke", "packages/smoke", {
        sentryCi: { enabled: false, roles: ["smoke"] },
      }),
    ]);
    assert.deepEqual(findProjectsByRole(projects, ["cloudflare", "smoke"]), {
      cloudflare: { name: "worker", path: "packages/worker" },
      smoke: { name: "smoke", path: "packages/smoke" },
    });
    assert.throws(
      () =>
        buildProjects([
          entry("worker", "packages/worker", {
            sentryCi: { roles: ["cloudflare"] },
          }),
          entry("other", "packages/other", {
            sentryCi: { roles: ["cloudflare"] },
          }),
        ]),
      /belongs to both/,
    );
  });
});
