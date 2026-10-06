/**
 * Tests for `sentry sourcemap inject` as a purely local command: it must
 * run without any stored or env-provided credentials, since it never calls
 * the Sentry API. Regression test for the `auth: false` opt-out.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { injectCommand } from "../../../src/commands/sourcemap/inject.js";
import { useEnvSandbox, useTestConfigDir } from "../../helpers.js";

type InjectFuncArgs = {
  ext?: string;
  "dry-run"?: boolean;
  "allow-empty"?: boolean;
};
type CmdFunc = (
  this: unknown,
  flags: InjectFuncArgs,
  dir: string
) => Promise<unknown>;

function makeContext() {
  return {
    stdout: { write: vi.fn(() => true) },
    stderr: { write: vi.fn(() => true) },
    cwd: "/tmp",
  };
}

describe("sourcemap inject command — runs without authentication", () => {
  // Fresh config dir → no stored OAuth token; env sandbox → no env token.
  // preload.ts sets a fake SENTRY_AUTH_TOKEN so the auth guard passes for
  // most tests; this suite deliberately removes it.
  useTestConfigDir("sentry-inject-noauth-");
  useEnvSandbox([
    "SENTRY_AUTH_TOKEN",
    "SENTRY_TOKEN",
    "SENTRY_FORCE_ENV_TOKEN",
  ]);

  let dir: string;
  let func: CmdFunc;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sentry-inject-noauth-"));
    func = (await injectCommand.loader()) as unknown as CmdFunc;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("injects debug IDs with no stored credentials and no env token", async () => {
    await writeFile(
      join(dir, "app.js"),
      "console.log(1);\n//# sourceMappingURL=app.js.map\n"
    );
    await writeFile(
      join(dir, "app.js.map"),
      '{"version":3,"file":"app.js","sources":["app.ts"],"names":[],"mappings":"AAAA"}\n'
    );
    const ctx = makeContext();

    await expect(func.call(ctx, {}, dir)).resolves.toBeUndefined();

    const js = await readFile(join(dir, "app.js"), "utf8");
    expect(js).toMatch(/^\/\/# debugId=[0-9a-f-]{36}$/m);
    const map = JSON.parse(await readFile(join(dir, "app.js.map"), "utf8"));
    expect(map.debugId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
