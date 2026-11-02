import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { clearSentryCliRcCache } from "../../src/lib/sentryclirc.js";
import {
  resetHostScopingState,
  useEnvSandbox,
  useTestConfigDir,
} from "../helpers.js";

vi.mock("../../src/lib/db/project-root-cache.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/lib/db/project-root-cache.js")
  >()),
  setCachedProjectRoot: vi.fn(async () => {
    throw new Error("database is locked");
  }),
}));

useTestConfigDir("project-context-");
useEnvSandbox([
  "SENTRY_AUTH_TOKEN",
  "SENTRY_TOKEN",
  "SENTRY_HOST",
  "SENTRY_URL",
]);

const dirs: string[] = [];

afterEach(async () => {
  clearSentryCliRcCache();
  await resetHostScopingState();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applies the .sentryclirc env shim when the project-root cache write fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "project-context-rc-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, ".sentryclirc"),
    "[defaults]\nurl = https://sentry.example.com\n[auth]\ntoken = rc-token\n",
  );
  clearSentryCliRcCache();

  const { preloadProjectContext } =
    await import("../../src/lib/project-context.js");
  await preloadProjectContext(dir);

  expect(process.env.SENTRY_AUTH_TOKEN).toBe("rc-token");
  expect(process.env.SENTRY_URL).toBe("https://sentry.example.com");
});
