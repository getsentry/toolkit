import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { packNpmAlias } from "../../script/lib/npm-alias.js";

describe("packNpmAlias", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sentry-npm-alias-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Pack a minimal `sentry` package and return its tarball path. */
  function packSentry(): string {
    const source = join(dir, "sentry");
    mkdirSync(join(source, "dist"), { recursive: true });
    writeFileSync(
      join(source, "package.json"),
      JSON.stringify({
        name: "sentry",
        version: "4.0.0",
        bin: { sentry: "./dist/bin.cjs" },
        files: ["dist/*.cjs", "README.md"],
        // Must not run: the alias is packed with --ignore-scripts.
        scripts: { prepack: "exit 1" },
      }),
    );
    writeFileSync(join(source, "dist", "bin.cjs"), "#!/usr/bin/env node\n");
    writeFileSync(join(source, "README.md"), "# sentry\n");
    execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--pack-destination", dir],
      { cwd: source, stdio: "ignore" },
    );
    return join(dir, "sentry-4.0.0.tgz");
  }

  test("renames the package and swaps the README", async () => {
    const readme = join(dir, "alias-README.md");
    writeFileSync(readme, "# @sentry/cli\n");
    const out = join(dir, "out");
    mkdirSync(out);

    await packNpmAlias(packSentry(), readme, out);

    expect(readdirSync(out)).toEqual(["sentry-cli-4.0.0.tgz"]);
    const extracted = join(dir, "extracted");
    mkdirSync(extracted);
    execFileSync("tar", [
      "-xzf",
      join(out, "sentry-cli-4.0.0.tgz"),
      "-C",
      extracted,
    ]);
    const manifest = JSON.parse(
      readFileSync(join(extracted, "package", "package.json"), "utf-8"),
    );
    expect(manifest).toMatchObject({
      name: "@sentry/cli",
      version: "4.0.0",
      bin: { sentry: "./dist/bin.cjs" },
      publishConfig: { access: "public" },
    });
    expect(readFileSync(join(extracted, "package", "README.md"), "utf-8")).toBe(
      "# @sentry/cli\n",
    );
    expect(
      readFileSync(join(extracted, "package", "dist", "bin.cjs"), "utf-8"),
    ).toBe("#!/usr/bin/env node\n");
  });
});
