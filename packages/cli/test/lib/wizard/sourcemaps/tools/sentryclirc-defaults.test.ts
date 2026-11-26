/**
 * `addOrgAndProjectToSentryCliRc`, which the generic and Wrangler source
 * maps flows call: the `[defaults]` it writes, read back the way v4 reads
 * `.sentryclirc`, next to the `[auth]` token and the user's other keys. It
 * never writes a self-hosted `url`, which v4 wouldn't trust from this file.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearSentryCliRcCache,
  loadSentryCliRc,
} from "../../../../../src/lib/sentryclirc.js";
import { addOrgAndProjectToSentryCliRc } from "../../../../../src/lib/wizard/sourcemaps/tools/sentry-cli.js";
import { addSentryCliConfig } from "../../../../../src/lib/wizard/utils/clack/index.js";

vi.mock("@clack/prompts", () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

let projectDir: string;
let configDir: string;
let originalCwd: string;
let originalConfigDir: string | undefined;

beforeEach(() => {
  originalCwd = process.cwd();
  originalConfigDir = process.env["SENTRY_CONFIG_DIR"];
  projectDir = mkdtempSync(path.join(tmpdir(), "wizard-rc-defaults-"));
  // An empty config dir so a global ~/.sentryclirc can't leak in.
  configDir = mkdtempSync(path.join(tmpdir(), "wizard-rc-defaults-config-"));
  process.env["SENTRY_CONFIG_DIR"] = configDir;
  process.chdir(projectDir);
  clearSentryCliRcCache();
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalConfigDir === undefined) {
    delete process.env["SENTRY_CONFIG_DIR"];
  } else {
    process.env["SENTRY_CONFIG_DIR"] = originalConfigDir;
  }
  clearSentryCliRcCache();
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

const rcPath = (): string => path.join(projectDir, ".sentryclirc");

const saasOptions = {
  orgSlug: "my-org",
  projectSlug: "my-project",
  url: "https://sentry.io/",
  selfHosted: false,
  authToken: "sntrys_tok",
};

describe("addOrgAndProjectToSentryCliRc", () => {
  it("writes the org and project, but no url, for sentry.io", async () => {
    await addOrgAndProjectToSentryCliRc(saasOptions);

    expect(readFileSync(rcPath(), "utf8")).toBe(
      "[defaults]\norg=my-org\nproject=my-project\n",
    );
  });

  it("writes no url for self-hosted Sentry, which users set as SENTRY_URL", async () => {
    await addOrgAndProjectToSentryCliRc({
      ...saasOptions,
      selfHosted: true,
      url: "https://sentry.example.com/",
    });

    expect(readFileSync(rcPath(), "utf8")).toBe(
      "[defaults]\norg=my-org\nproject=my-project\n",
    );
    expect((await loadSentryCliRc(projectDir)).url).toBeUndefined();
  });

  it("keeps the [auth] token and the user's other keys", async () => {
    writeFileSync(
      rcPath(),
      "# my settings\n[defaults]\norg=old-org\n\n[http]\nverify_ssl=false\n",
    );
    await addSentryCliConfig({ authToken: "sntrys_tok" });
    await addOrgAndProjectToSentryCliRc(saasOptions);

    const contents = readFileSync(rcPath(), "utf8");
    expect(contents).toContain("# my settings");
    expect(contents).toContain("[http]\nverify_ssl=false");
    expect(contents).not.toContain("old-org");

    const config = await loadSentryCliRc(projectDir);
    expect(config.org).toBe("my-org");
    expect(config.project).toBe("my-project");
    expect(config.token).toBe("sntrys_tok");
  });
});
