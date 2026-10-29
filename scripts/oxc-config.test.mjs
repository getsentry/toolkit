import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function readRootJson(path) {
  return JSON.parse(
    readFileSync(new URL(`../${path}`, import.meta.url), "utf8"),
  );
}

test("Oxlint retains its default correctness plugins alongside accessibility", () => {
  const { plugins } = readRootJson(".oxlintrc.json");
  for (const plugin of ["eslint", "typescript", "unicorn", "oxc", "jsx-a11y"]) {
    assert.ok(plugins.includes(plugin), `${plugin} plugin must remain enabled`);
  }
});

test("CLI command and color imports retain their wrapper boundary", () => {
  const { overrides } = readRootJson(".oxlintrc.json");
  const cli = overrides.find(({ files }) =>
    files.includes("packages/cli/src/**/*.{ts,tsx}"),
  );
  const commands = overrides.find(({ files }) =>
    files.includes("packages/cli/src/commands/**/*.{ts,tsx}"),
  );
  const wrappers = overrides.find(({ files }) =>
    files.includes("packages/cli/src/lib/command.ts"),
  );
  assert.deepEqual(cli.rules["no-restricted-imports"][1].paths[0].importNames, [
    "buildCommand",
    "buildRouteMap",
  ]);
  assert.deepEqual(
    commands.rules["no-restricted-imports"][1].paths.map(({ name }) => name),
    ["@stricli/core", "chalk"],
  );
  assert.equal(wrappers.rules["no-restricted-imports"], "off");
});

test("editor and staged files use Oxc for root, MCP, and CLI", () => {
  const settings = readRootJson(".vscode/settings.json");
  const cliSettings = readRootJson("packages/cli/.vscode/settings.json");
  const formatter = readRootJson(".oxfmtrc.json");
  const extensions = readRootJson(".vscode/extensions.json");
  const packageJson = readRootJson("package.json");

  assert.equal(settings["editor.defaultFormatter"], "oxc.oxc-vscode");
  assert.equal(
    settings["editor.codeActionsOnSave"]["source.fixAll.oxc"],
    "explicit",
  );
  assert.equal(cliSettings["editor.defaultFormatter"], "oxc.oxc-vscode");
  assert.equal(
    cliSettings["editor.codeActionsOnSave"]["source.fixAll.oxc"],
    "explicit",
  );
  assert.ok(!formatter.ignorePatterns.includes("packages/cli/**"));
  assert.deepEqual(extensions.recommendations, ["oxc.oxc-vscode"]);
  assert.deepEqual(Object.keys(packageJson["lint-staged"]), ["*"]);
});

test("CI lint checks formatting for commits that skip the pre-commit hook", () => {
  const { scripts } = readRootJson("package.json");
  const workflow = readFileSync(
    new URL("../.github/workflows/test.yml", import.meta.url),
    "utf8",
  );

  assert.equal(scripts["lint:format"], "oxfmt --check");
  assert.match(scripts.lint, /pnpm run lint:format/);
  assert.match(workflow, /^\s*- run: pnpm run lint$/m);
});

test("mcp-core and toolkit-core cannot import the CLI", () => {
  const { overrides } = readRootJson(".oxlintrc.json");
  const { scripts } = readRootJson("package.json");
  const shared = overrides.find(({ files }) =>
    files.includes("packages/mcp-core/**/*.{ts,tsx,js,mjs,cjs}"),
  );
  assert.ok(
    shared.files.includes("packages/toolkit-core/**/*.{ts,tsx,js,mjs,cjs}"),
  );
  const [level, { paths, patterns }] = shared.rules["no-restricted-imports"];
  assert.equal(level, "error");
  assert.deepEqual(
    paths.map(({ name }) => name),
    ["sentry"],
  );
  assert.ok(patterns[0].group.includes("sentry/**"));
  assert.match(scripts.lint, /pnpm run lint:deps/);
});
