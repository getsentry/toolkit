/**
 * The `cli` script runs the CLI from source. A lazy relative `require` there
 * must return the module the ESM graph already loaded, not compile a second,
 * CommonJS copy of the module's whole graph (as the `tsx` loader did), which
 * can't load packages that export only to `import` (`@sentry/api/client`).
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const pkgRoot = join(import.meta.dirname, "..", "..");
const RUNNER_RE = /&& (.+) src\/bin\.ts$/;

test("the cli script shares module instances with lazy requires", () => {
  const { scripts } = JSON.parse(
    readFileSync(join(pkgRoot, "package.json"), "utf-8"),
  ) as { scripts: Record<string, string> };
  const runner = scripts.cli?.match(RUNNER_RE)?.[1];
  expect(runner, "cli script runs `<runner> src/bin.ts`").toBeDefined();

  const [command, ...args] = (runner as string).split(" ");
  const result = spawnSync(
    command,
    [...args, "test/fixtures/dev-runner/lazy-require.ts"],
    { cwd: pkgRoot, encoding: "utf-8" },
  );
  expect(result.stdout, result.stderr).toBe("same");
});
