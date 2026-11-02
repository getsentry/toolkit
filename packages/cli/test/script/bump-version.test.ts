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
const skill = "plugins/sentry-cli/skills/sentry-cli";
const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0))
    rmSync(fixture, { recursive: true, force: true });
});

/**
 * Lay out `cli/` and its sibling `mcp-server/` like `packages/`, with a fake
 * `npm` binary whose `npm version` writes the requested version.
 */
function createFixture(): { root: string; cli: string; bin: string } {
  const root = mkdtempSync(join(tmpdir(), "cli-bump-version-"));
  fixtures.push(root);
  const cli = join(root, "cli");
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(cli, skill, "references"), { recursive: true });
  mkdirSync(join(cli, "plugins/sentry-cli/.claude-plugin"), {
    recursive: true,
  });
  mkdirSync(join(root, "mcp-server"));
  writeFileSync(join(cli, "package.json"), '{"version":"0.47.0"}\n');
  writeFileSync(
    join(root, "mcp-server/package.json"),
    '{"version":"0.42.0"}\n',
  );
  writeFileSync(
    join(cli, "plugins/sentry-cli/.claude-plugin/plugin.json"),
    '{"version":"0.47.0"}\n',
  );
  for (const path of ["SKILL.md", "references/auth.md"]) {
    writeFileSync(
      join(cli, skill, path),
      "---\nname: sentry-cli\nversion: 0.47.0-dev.0\n---\n\nContent\n",
    );
  }

  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env node
require("node:fs").writeFileSync("package.json", JSON.stringify({ version: process.argv.at(-1) }) + "\\n");
`,
  );
  chmodSync(join(bin, "npm"), 0o755);
  return { root, cli, bin };
}

function runScript(
  { cli, bin }: { cli: string; bin: string },
  env: Record<string, string>,
) {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", script, "--pre"],
    {
      cwd: cli,
      encoding: "utf8",
      env: {
        HOME: cli,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        XDG_CONFIG_HOME: cli,
        ...env,
      },
      timeout: 15_000,
    },
  );
}

function readVersion(path: string): string {
  return (JSON.parse(readFileSync(path, "utf8")) as { version: string })
    .version;
}

test("pre-release bump gives @sentry/mcp-server the release version", () => {
  const fixture = createFixture();

  const result = runScript(fixture, { CRAFT_NEW_VERSION: "0.48.0" });

  expect(result.status, result.stderr).toBe(0);
  expect(readVersion(join(fixture.cli, "package.json"))).toBe("0.48.0");
  expect(readVersion(join(fixture.root, "mcp-server/package.json"))).toBe(
    "0.48.0",
  );
});

// Craft's post-release bump reruns the pre-release command with the next
// development version.
test("dev version bump syncs every tracked version", () => {
  const fixture = createFixture();

  const result = runScript(fixture, { CRAFT_NEW_VERSION: "0.49.0-dev.0" });

  expect(result.status, result.stderr).toBe(0);
  for (const path of ["package.json", "../mcp-server/package.json"]) {
    expect(readVersion(join(fixture.cli, path))).toBe("0.49.0-dev.0");
  }
  expect(
    readVersion(
      join(fixture.cli, "plugins/sentry-cli/.claude-plugin/plugin.json"),
    ),
  ).toBe("0.49.0");
  for (const path of ["SKILL.md", "references/auth.md"]) {
    expect(readFileSync(join(fixture.cli, skill, path), "utf8")).toContain(
      "version: 0.49.0-dev.0",
    );
  }
});
