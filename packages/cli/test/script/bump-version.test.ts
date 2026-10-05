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
  "../../script/bump-version.ts"
);
const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0))
    rmSync(fixture, { recursive: true, force: true });
});

test("post-release bump updates tracked skill versions before committing", () => {
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
    '{"version":"0.47.0"}\n'
  );
  for (const path of ["SKILL.md", "references/auth.md"]) {
    writeFileSync(
      join(cwd, skill, path),
      "---\nname: sentry-cli\nversion: 0.47.0-dev.0\n---\n\nContent\n"
    );
  }

  writeFileSync(
    join(bin, "npm"),
    '#!/usr/bin/env node\nrequire("node:fs").writeFileSync("package.json", JSON.stringify({ version: "0.48.0-dev.0" }) + "\\n");\n'
  );
  writeFileSync(
    join(bin, "git"),
    `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv[2] === "diff") process.exit(1);
if (process.argv[2] === "commit") {
  for (const path of ["SKILL.md", "references/auth.md"]) {
    const content = fs.readFileSync(${JSON.stringify(skill)} + "/" + path, "utf8");
    if (!content.includes("version: 0.48.0-dev.0")) process.exit(2);
  }
}
fs.appendFileSync("git-commands", process.argv[2] + "\\n");
`
  );
  chmodSync(join(bin, "npm"), 0o755);
  chmodSync(join(bin, "git"), 0o755);

  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", script, "--post"],
    {
      cwd,
      encoding: "utf8",
      env: {
        HOME: cwd,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        XDG_CONFIG_HOME: cwd,
      },
      timeout: 15_000,
    }
  );

  expect(result.status, result.stderr).toBe(0);
  for (const path of ["SKILL.md", "references/auth.md"]) {
    expect(readFileSync(join(cwd, skill, path), "utf8")).toContain(
      "version: 0.48.0-dev.0"
    );
  }
  expect(readFileSync(join(cwd, "git-commands"), "utf8")).toBe(
    "commit\npull\npush\n"
  );
});
