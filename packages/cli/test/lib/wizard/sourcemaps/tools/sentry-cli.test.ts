import { promises } from "node:fs";

import {
  addSentryCommandToBuildCommand,
  getSentryCliNpmScript,
  setSentryCliRcDefaults,
} from "../../../../../src/lib/wizard/sourcemaps/tools/sentry-cli.js";

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as packageManagerHelpers from "../../../../../src/lib/wizard/utils/package-manager.js";
import { getPackageDotJson } from "../../../../../src/lib/wizard/utils/clack/index.js";

import { vi, it, describe, expect, afterEach } from "vitest";

const writeFileSpy = vi
  .spyOn(promises, "writeFile")
  .mockImplementation(() => Promise.resolve());

vi.mock("@clack/prompts", () => {
  return {
    log: {
      info: vi.fn(),
      success: vi.fn(),
    },
    confirm: vi.fn().mockResolvedValue(true),
    select: vi.fn().mockResolvedValue(true),
    isCancel: vi.fn().mockReturnValue(false),
  };
});
vi.mock("../../../../../src/lib/wizard/utils/clack/index.js", async () => ({
  ...(await vi.importActual(
    "../../../../../src/lib/wizard/utils/clack/index.js",
  )),
  getPackageDotJson: vi.fn().mockResolvedValue({
    scripts: {
      build: "tsc",
    },
    version: "1.0.0",
  }),
}));

describe("addSentryCommandToBuildCommand", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });
  it.each([
    [
      packageManagerHelpers.NPM,
      packageManagerHelpers.PNPM,
      packageManagerHelpers.YARN_V1,
      packageManagerHelpers.YARN_V2,
      packageManagerHelpers.BUN,
      packageManagerHelpers.DENO,
    ],
  ])("adds the cli command to the script command (%s)", async (_, pacMan) => {
    vi.spyOn(packageManagerHelpers, "_detectPackageManger").mockReturnValue(
      pacMan,
    );
    await addSentryCommandToBuildCommand();
    expect(writeFileSpy).toHaveBeenCalledWith(
      expect.stringContaining("package.json"),
      expect.stringContaining(
        `tsc && ${pacMan.runScriptCommand} sentry:sourcemaps`,
      ),
    );
  });

  it("does not add the cli command to the script command if it is already in there", async () => {
    vi.mocked(getPackageDotJson).mockResolvedValue({
      scripts: {
        build: "tsc && sentry:sourcemaps",
      },
      version: "1.0.0",
    });

    await addSentryCommandToBuildCommand();

    expect(writeFileSpy).not.toHaveBeenCalled();
  });

  it("skips the separate CI step prompt when the build already runs the script", async () => {
    // `addedToBuildCommand` is module state, so start from a fresh module.
    vi.resetModules();
    const clackPrompts = await import("@clack/prompts");
    const sentryCli =
      await import("../../../../../src/lib/wizard/sourcemaps/tools/sentry-cli.js");
    const clackHelpers =
      await import("../../../../../src/lib/wizard/utils/clack/index.js");
    vi.mocked(clackHelpers.getPackageDotJson).mockResolvedValue({
      scripts: { build: "tsc && npm run sentry:sourcemaps" },
      version: "1.0.0",
    });

    await sentryCli.addSentryCommandToBuildCommand();
    await sentryCli.setupNpmScriptInCI();

    expect(clackPrompts.select).not.toHaveBeenCalled();
  });
});

describe("getSentryCliNpmScript", () => {
  it("injects debug IDs and uploads with v4 sentry commands, without org or project flags", () => {
    expect(getSentryCliNpmScript("./dist")).toBe(
      "sentry sourcemap inject ./dist && sentry sourcemap upload ./dist",
    );
  });
});

describe("setSentryCliRcDefaults", () => {
  const values = { org: "my-org", project: "my-project" };

  it("creates a [defaults] section in an empty file", () => {
    expect(setSentryCliRcDefaults("", values)).toBe(
      "[defaults]\norg=my-org\nproject=my-project\n",
    );
  });

  it("appends [defaults] after other sections and keeps them", () => {
    expect(setSentryCliRcDefaults("[auth]\ntoken=abc\n", values)).toBe(
      "[auth]\ntoken=abc\n\n[defaults]\norg=my-org\nproject=my-project\n",
    );
    expect(setSentryCliRcDefaults("[auth]\ntoken=abc", values)).toBe(
      "[auth]\ntoken=abc\n\n[defaults]\norg=my-org\nproject=my-project\n",
    );
  });

  it("updates existing keys and keeps other keys, comments, and sections", () => {
    const contents = [
      "; managed by hand",
      "[defaults]",
      "url = https://sentry.example.com/",
      "org = old-org",
      "",
      "[auth]",
      "token=abc",
      "",
    ].join("\n");

    expect(setSentryCliRcDefaults(contents, values)).toBe(
      [
        "; managed by hand",
        "[defaults]",
        "project=my-project",
        "url = https://sentry.example.com/",
        "org=my-org",
        "",
        "[auth]",
        "token=abc",
        "",
      ].join("\n"),
    );
  });

  it("does not touch org or project keys outside [defaults]", () => {
    expect(
      setSentryCliRcDefaults("[other]\norg=keep\n[DEFAULTS]\n", values),
    ).toBe("[other]\norg=keep\n[DEFAULTS]\norg=my-org\nproject=my-project\n");
  });

  it("updates keys in every [defaults] section", () => {
    expect(
      setSentryCliRcDefaults(
        "[defaults]\norg=a\n[auth]\ntoken=t\n[defaults]\nproject=b\n",
        values,
      ),
    ).toBe(
      "[defaults]\norg=my-org\n[auth]\ntoken=t\n[defaults]\nproject=my-project\n",
    );
  });

  it("keeps CRLF line endings on updated lines", () => {
    expect(
      setSentryCliRcDefaults("[defaults]\r\norg=a\r\nproject=b\r\n", values),
    ).toBe("[defaults]\r\norg=my-org\r\nproject=my-project\r\n");
  });
});
