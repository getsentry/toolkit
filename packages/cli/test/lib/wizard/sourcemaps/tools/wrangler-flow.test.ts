import { promises } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { WizardExitError } from "../../../../../src/lib/errors.js";
import { SENTRY_CLI_PACKAGE_SPEC } from "../../../../../src/lib/wizard/sourcemaps/tools/sentry-cli.js";
import { configureWrangler } from "../../../../../src/lib/wizard/sourcemaps/tools/wrangler.js";
import {
  getPackageDotJson,
  installPackage,
} from "../../../../../src/lib/wizard/utils/clack/index.js";

const { selectMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
}));

const writeFileSpy = vi
  .spyOn(promises, "writeFile")
  .mockImplementation(() => Promise.resolve());

vi.mock("@clack/prompts", () => ({
  log: { info: vi.fn(), warn: vi.fn(), success: vi.fn() },
  note: vi.fn(),
  outro: vi.fn(),
  confirm: vi.fn().mockResolvedValue(true),
  select: selectMock,
  isCancel: vi.fn().mockReturnValue(false),
}));
vi.mock("../../../../../src/lib/wizard/utils/clack/index.js", async () => ({
  ...(await vi.importActual(
    "../../../../../src/lib/wizard/utils/clack/index.js",
  )),
  installPackage: vi.fn().mockResolvedValue(undefined),
  addSentryCliConfig: vi.fn().mockResolvedValue(undefined),
  getPackageDotJson: vi.fn(),
}));

const options = {
  authToken: "token",
  orgSlug: "my-org",
  projectSlug: "my-project",
  selfHosted: false,
  url: "https://sentry.io/",
};

describe("configureWrangler", () => {
  it("exits when the user keeps the existing sentry:sourcemaps script", async () => {
    vi.mocked(getPackageDotJson).mockResolvedValue({
      scripts: {
        deploy: "wrangler deploy",
        "sentry:sourcemaps": "echo existing",
      },
    });
    selectMock.mockResolvedValueOnce(false);

    await expect(configureWrangler(options)).rejects.toThrow(WizardExitError);
    expect(writeFileSpy).not.toHaveBeenCalled();
  });

  it("installs the sentry CLI major the wizard runs on", async () => {
    vi.mocked(getPackageDotJson).mockResolvedValue({
      scripts: { "sentry:sourcemaps": "echo existing" },
    });
    selectMock.mockResolvedValueOnce(false);

    await expect(configureWrangler(options)).rejects.toThrow(WizardExitError);
    expect(installPackage).toHaveBeenCalledWith(
      expect.objectContaining({ packageName: SENTRY_CLI_PACKAGE_SPEC }),
    );
  });
});
