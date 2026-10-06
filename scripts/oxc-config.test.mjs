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

test("editor uses Oxc for root and MCP while CLI retains Biome", () => {
  const settings = readRootJson(".vscode/settings.json");
  const formatter = readRootJson(".oxfmtrc.json");
  const extensions = readRootJson(".vscode/extensions.json");

  assert.equal(settings["editor.defaultFormatter"], "oxc.oxc-vscode");
  assert.equal(
    settings["editor.codeActionsOnSave"]["source.fixAll.oxc"],
    "explicit",
  );
  assert.equal(
    settings["editor.codeActionsOnSave"]["source.fixAll.biome"],
    undefined,
  );
  for (const language of ["[json]", "[typescript]", "[typescriptreact]"]) {
    assert.notEqual(
      settings[language]?.["editor.defaultFormatter"],
      "biomejs.biome",
    );
  }
  assert.ok(formatter.ignorePatterns.includes("packages/cli/**"));
  assert.ok(extensions.recommendations.includes("oxc.oxc-vscode"));
  assert.ok(extensions.recommendations.includes("biomejs.biome"));
});
