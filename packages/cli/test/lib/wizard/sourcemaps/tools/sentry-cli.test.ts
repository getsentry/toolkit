import { promises } from "node:fs";

import {
  addSentryCommandToBuildCommand,
  getSentryCliNpmScript,
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
});

describe("getSentryCliNpmScript", () => {
  it("injects debug IDs and uploads with v4 sentry commands", () => {
    expect(
      getSentryCliNpmScript(
        { orgSlug: "my-org", projectSlug: "my-project" },
        "./dist",
      ),
    ).toBe(
      "sentry sourcemap inject ./dist && sentry sourcemap upload --org my-org --project my-project ./dist",
    );
  });
});
