import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clack/prompts", () => ({
  log: { info: vi.fn(), warn: vi.fn(), success: vi.fn() },
}));

import { createExamplePage } from "../../../../src/lib/wizard/remix/sdk-example.js";

describe("createExamplePage (Remix)", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(path.join(tmpdir(), "remix-example-test-"));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each([
    [true, "ts"],
    [false, "js"],
  ])(
    "creates the API route the example page fetches (isTS: %s)",
    async (isTS, ext) => {
      await createExamplePage({
        selfHosted: false,
        orgSlug: "org",
        projectId: "1",
        url: "https://sentry.io/",
        isTS,
      });

      const page = readFileSync(
        path.join(tmpDir, `app/routes/sentry-example-page.${ext}x`),
        "utf-8",
      );
      expect(page).toContain('fetch("/api/sentry-example-api")');

      // Remix flat routes map api.sentry-example-api to /api/sentry-example-api.
      const apiRoute = path.join(
        tmpDir,
        `app/routes/api.sentry-example-api.${ext}`,
      );
      expect(existsSync(apiRoute)).toBe(true);
      const api = readFileSync(apiRoute, "utf-8");
      expect(api).toContain('import * as Sentry from "@sentry/remix";');
      expect(api).toContain("export async function loader()");
      expect(api).toContain("throw new SentryExampleBackendError(");
    },
  );
});
