/**
 * `.sentryclirc` written by the wizard, read back the way v4 reads it.
 *
 * Writes the `[defaults]` org/project and the `[auth]` token into a real
 * temp dir in both orders and checks that `loadSentryCliRc` resolves all
 * three, and that `.sentryclirc` ends up in `.gitignore`.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearSentryCliRcCache,
  loadSentryCliRc,
} from "../../../../../src/lib/sentryclirc.js";
import { setSentryCliRcDefaults } from "../../../../../src/lib/wizard/sourcemaps/tools/sentry-cli.js";
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
  projectDir = mkdtempSync(path.join(tmpdir(), "wizard-rc-"));
  // An empty config dir so a global ~/.sentryclirc can't leak in.
  configDir = mkdtempSync(path.join(tmpdir(), "wizard-rc-config-"));
  process.env["SENTRY_CONFIG_DIR"] = configDir;
  writeFileSync(path.join(projectDir, ".gitignore"), "node_modules\n");
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

function writeDefaults(): void {
  const contents = existsSync(rcPath()) ? readFileSync(rcPath(), "utf8") : "";
  writeFileSync(
    rcPath(),
    setSentryCliRcDefaults(contents, { org: "my-org", project: "my-project" }),
  );
}

async function expectV4ReadsAll(): Promise<void> {
  const config = await loadSentryCliRc(projectDir);
  expect(config.org).toBe("my-org");
  expect(config.project).toBe("my-project");
  expect(config.token).toBe("sntrys_tok");
  expect(
    readFileSync(path.join(projectDir, ".gitignore"), "utf8").split("\n"),
  ).toContain(".sentryclirc");
}

describe(".sentryclirc written by the wizard", () => {
  it("keeps [auth] when [defaults] is written first", async () => {
    writeDefaults();
    await addSentryCliConfig({ authToken: "sntrys_tok" });
    await expectV4ReadsAll();
  });

  it("keeps [auth] when [defaults] is written after the token", async () => {
    await addSentryCliConfig({ authToken: "sntrys_tok" });
    writeDefaults();
    await expectV4ReadsAll();
  });

  it("keeps the user's other keys", async () => {
    writeFileSync(rcPath(), "[defaults]\nurl=https://sentry.example.com/\n");
    writeDefaults();
    await addSentryCliConfig({ authToken: "sntrys_tok" });
    await expectV4ReadsAll();
    expect((await loadSentryCliRc(projectDir)).url).toBe(
      "https://sentry.example.com/",
    );
  });
});
