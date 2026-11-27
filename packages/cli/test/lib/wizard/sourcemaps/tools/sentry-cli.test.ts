import { mkdtempSync, promises, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  addSentryCommandToBuildCommand,
  configureSentryCLI,
  getSentryCliNpmScript,
  setSentryCliRcDefaults,
} from "../../../../../src/lib/wizard/sourcemaps/tools/sentry-cli.js";

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as packageManagerHelpers from "../../../../../src/lib/wizard/utils/package-manager.js";
import { getPackageDotJson } from "../../../../../src/lib/wizard/utils/clack/index.js";

import { vi, it, describe, expect, afterEach } from "vitest";

const { selectMock, textMock } = vi.hoisted(() => ({
  selectMock: vi.fn().mockResolvedValue(true),
  textMock: vi.fn(),
}));

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
    select: selectMock,
    text: textMock,
    isCancel: vi.fn().mockReturnValue(false),
  };
});
vi.mock("../../../../../src/lib/wizard/utils/clack/index.js", async () => ({
  ...(await vi.importActual(
    "../../../../../src/lib/wizard/utils/clack/index.js",
  )),
  installPackage: vi.fn().mockResolvedValue(undefined),
  addSentryCliConfig: vi.fn().mockResolvedValue(undefined),
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

  it("does not ask for a CI step when the build command already runs the script", async () => {
    // A fresh module, so `addedToBuildCommand` starts out false
    vi.resetModules();
    const { getPackageDotJson: freshGetPackageDotJson } =
      await import("../../../../../src/lib/wizard/utils/clack/index.js");
    vi.mocked(freshGetPackageDotJson).mockResolvedValue({
      scripts: {
        build: "tsc && sentry:sourcemaps",
      },
      version: "1.0.0",
    });
    const sentryCli =
      await import("../../../../../src/lib/wizard/sourcemaps/tools/sentry-cli.js");

    await sentryCli.addSentryCommandToBuildCommand();
    await sentryCli.setupNpmScriptInCI();

    expect(selectMock).not.toHaveBeenCalled();
  });
});

describe("getSentryCliNpmScript", () => {
  it("injects debug IDs and uploads with v4 sentry commands, without org or project flags", () => {
    expect(getSentryCliNpmScript("./dist")).toBe(
      "sentry sourcemap inject ./dist && sentry sourcemap upload ./dist",
    );
  });

  it.each(["dist", ".", "./build/client"])(
    "leaves the plain path %s unquoted",
    (artifactPath) => {
      expect(getSentryCliNpmScript(artifactPath)).toBe(
        `sentry sourcemap inject ${artifactPath} && sentry sourcemap upload ${artifactPath}`,
      );
    },
  );

  it.each([
    ["dist/my app", '"dist/my app"'],
    ["out/(client)", '"out/(client)"'],
    ['dist/a"b', '"dist/a\\"b"'],
    ["dist/$HOME", '"dist/\\$HOME"'],
  ])("double-quotes %s as %s", (artifactPath, quoted) => {
    expect(getSentryCliNpmScript(artifactPath)).toBe(
      `sentry sourcemap inject ${quoted} && sentry sourcemap upload ${quoted}`,
    );
  });
});

describe("configureSentryCLI", () => {
  it("uses . for an absolute artifact path that is the project root", async () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "sentry-cli-")));
    const originalCwd = process.cwd();
    try {
      process.chdir(dir);
      textMock.mockResolvedValueOnce(dir);
      // Don't append the script to the build command.
      selectMock.mockResolvedValueOnce(false);
      vi.mocked(getPackageDotJson).mockResolvedValue({
        scripts: { build: "tsc" },
        version: "1.0.0",
      });

      await configureSentryCLI(
        {
          orgSlug: "my-org",
          projectSlug: "my-project",
          selfHosted: false,
          url: "https://sentry.io/",
          authToken: "token",
        },
        () => Promise.resolve(),
        true,
      );

      expect(writeFileSpy).toHaveBeenCalledWith(
        expect.stringContaining("package.json"),
        expect.stringContaining(
          '"sentry:sourcemaps": "sentry sourcemap inject . && sentry sourcemap upload ."',
        ),
      );
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
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
