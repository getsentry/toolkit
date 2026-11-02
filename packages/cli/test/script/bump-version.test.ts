import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const script = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../script/bump-version.ts",
);
const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0))
    rmSync(fixture, { recursive: true, force: true });
});

// Craft's postReleaseBump writes the development version through this same
// command, so it must update every tracked version before Craft commits.
test("version bump updates package, plugin, and tracked skill versions", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cli-bump-version-"));
  fixtures.push(cwd);
  const bin = join(cwd, "bin");
  const skill = "plugins/sentry-cli/skills/sentry-cli";
  mkdirSync(bin);
  mkdirSync(join(cwd, skill, "references"), { recursive: true });
  mkdirSync(join(cwd, "plugins/sentry-cli/.claude-plugin"), {
    recursive: true,
  });
  writeFileSync(join(cwd, "package.json"), '{"version":"0.47.0"}\n');
  writeFileSync(
    join(cwd, "plugins/sentry-cli/.claude-plugin/plugin.json"),
    '{"version":"0.47.0"}\n',
  );
  for (const path of ["SKILL.md", "references/auth.md"]) {
    writeFileSync(
      join(cwd, skill, path),
      "---\nname: sentry-cli\nversion: 0.47.0\n---\n\nContent\n",
    );
  }

  writeFileSync(
    join(bin, "npm"),
    '#!/usr/bin/env node\nrequire("node:fs").writeFileSync("package.json", JSON.stringify({ version: process.argv.at(-1) }) + "\\n");\n',
  );
  chmodSync(join(bin, "npm"), 0o755);

  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", script, "--pre"],
    {
      cwd,
      encoding: "utf8",
      env: {
        CRAFT_NEW_VERSION: "0.48.0-dev.0",
        HOME: cwd,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        XDG_CONFIG_HOME: cwd,
      },
      timeout: 15_000,
    },
  );

  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"))).toEqual({
    version: "0.48.0-dev.0",
  });
  expect(
    JSON.parse(
      readFileSync(
        join(cwd, "plugins/sentry-cli/.claude-plugin/plugin.json"),
        "utf8",
      ),
    ),
  ).toEqual({ version: "0.48.0" });
  for (const path of ["SKILL.md", "references/auth.md"]) {
    expect(readFileSync(join(cwd, skill, path), "utf8")).toContain(
      "version: 0.48.0-dev.0",
    );
  }
});
