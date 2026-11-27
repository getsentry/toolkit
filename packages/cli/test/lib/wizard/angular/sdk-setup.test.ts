import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeSentryOnApplicationEntry } from "../../../../src/lib/wizard/angular/sdk-setup.js";
import { clack } from "../../../../src/lib/wizard/utils/clack/prompts.js";

describe("initializeSentryOnApplicationEntry", () => {
  let dir: string;
  let cwd: string;

  beforeEach(() => {
    cwd = process.cwd();
    dir = mkdtempSync(path.join(tmpdir(), "angular-entry-"));
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("shows the manual setup steps and returns when src/main.ts is missing", async () => {
    const error = vi.spyOn(clack.log, "error").mockImplementation(() => {});
    const warn = vi.spyOn(clack.log, "warn").mockImplementation(() => {});

    await expect(
      initializeSentryOnApplicationEntry(
        "https://public@o0.ingest.sentry.io/0",
        { performance: true, replay: false },
        false,
      ),
    ).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(expect.stringContaining("main.ts"));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("guides/angular/#configure"),
    );
  });
});
