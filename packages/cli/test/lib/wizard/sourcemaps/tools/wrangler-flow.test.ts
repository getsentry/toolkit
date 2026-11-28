import { promises } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { WizardExitError } from "../../../../../src/lib/errors.js";
import {
  addUploadTargetToSentryCliRc,
  SENTRY_CLI_PACKAGE_SPEC,
} from "../../../../../src/lib/wizard/sourcemaps/tools/sentry-cli.js";
import { configureWrangler } from "../../../../../src/lib/wizard/sourcemaps/tools/wrangler.js";
import {
  addSentryCliConfig,
  getPackageDotJson,
  getPackageManager,
  installPackage,
  showCopyPasteInstructions,
} from "../../../../../src/lib/wizard/utils/clack/index.js";
import type { PackageDotJson } from "../../../../../src/lib/wizard/utils/package-json.js";
import {
  NPM,
  YARN_V2,
} from "../../../../../src/lib/wizard/utils/package-manager.js";

const { selectMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
}));

const writeFileSpy = vi.spyOn(promises, "writeFile");

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
  getPackageManager: vi.fn(),
  showCopyPasteInstructions: vi.fn().mockResolvedValue(undefined),
}));
vi.mock(
  "../../../../../src/lib/wizard/sourcemaps/tools/sentry-cli.js",
  async () => ({
    ...(await vi.importActual(
      "../../../../../src/lib/wizard/sourcemaps/tools/sentry-cli.js",
    )),
    addUploadTargetToSentryCliRc: vi.fn().mockResolvedValue(undefined),
  }),
);

const options = {
  authToken: "token",
  orgSlug: "my-org",
  projectSlug: "my-project",
  selfHosted: false,
  url: "https://sentry.io/",
};

/** The package.json the wizard reads, updated by each write. */
let pkg: PackageDotJson;

function usePackageJson(scripts: Record<string, string>): void {
  pkg = { scripts };
  vi.mocked(getPackageDotJson).mockImplementation(() =>
    Promise.resolve(structuredClone(pkg)),
  );
}

describe("configureWrangler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPackageManager).mockResolvedValue(NPM);
    writeFileSpy.mockImplementation((_path, data) => {
      if (typeof data === "string") {
        pkg = JSON.parse(data) as PackageDotJson;
      }
      return Promise.resolve();
    });
  });

  it("exits when the user keeps the existing sentry:sourcemaps script", async () => {
    usePackageJson({
      deploy: "wrangler deploy",
      "sentry:sourcemaps": "echo existing",
    });
    selectMock.mockResolvedValueOnce(false);

    await expect(configureWrangler(options)).rejects.toThrow(WizardExitError);
    expect(writeFileSpy).not.toHaveBeenCalled();
  });

  it("uploads from a new postdeploy script", async () => {
    usePackageJson({ deploy: "wrangler deploy" });

    await configureWrangler(options);

    expect(pkg.scripts?.["postdeploy"]).toBe("npm run sentry:sourcemaps");
    expect(pkg.scripts?.["deploy"]).toContain("--upload-source-maps");
  });

  it("keeps an existing postdeploy script and uploads after it", async () => {
    usePackageJson({ deploy: "wrangler deploy", postdeploy: "echo done" });

    await configureWrangler(options);

    expect(pkg.scripts?.["postdeploy"]).toBe(
      "echo done && npm run sentry:sourcemaps",
    );
  });

  it("chains the upload onto the deploy script for Yarn 2+", async () => {
    vi.mocked(getPackageManager).mockResolvedValue(YARN_V2);
    usePackageJson({ deploy: "wrangler deploy" });

    await configureWrangler(options);

    expect(pkg.scripts?.["postdeploy"]).toBeUndefined();
    expect(pkg.scripts?.["deploy"]).toMatch(
      /^wrangler deploy .*--upload-source-maps.* && yarn sentry:sourcemaps$/,
    );
  });

  it("puts the Yarn 2+ upload in the manual deploy command when it can't edit the script", async () => {
    vi.mocked(getPackageManager).mockResolvedValue(YARN_V2);
    usePackageJson({ build: "tsc" });
    selectMock.mockResolvedValueOnce("build");

    await configureWrangler(options);

    expect(pkg.scripts?.["build"]).toBe("tsc");
    expect(showCopyPasteInstructions).toHaveBeenCalledWith(
      expect.objectContaining({
        codeSnippet: expect.stringMatching(
          /^wrangler deploy --outdir .* --upload-source-maps && yarn sentry:sourcemaps$/,
        ),
      }),
    );
  });

  it("edits a deploy script that runs wrangler through npx", async () => {
    usePackageJson({ deploy: "npx wrangler deploy" });

    await configureWrangler(options);

    expect(pkg.scripts?.["deploy"]).toMatch(
      /^npx wrangler deploy --outdir '.*' --upload-source-maps --var SENTRY_RELEASE:/,
    );
  });

  it("still sets up the upload when there is no deploy script", async () => {
    usePackageJson({ build: "tsc" });
    selectMock.mockResolvedValueOnce("none");

    await configureWrangler(options);

    expect(pkg.scripts?.["sentry:sourcemaps"]).toContain(
      "sentry sourcemap upload",
    );
    expect(pkg.scripts?.["build"]).toBe("tsc");
    expect(addUploadTargetToSentryCliRc).toHaveBeenCalledWith(options);
    expect(addSentryCliConfig).toHaveBeenCalledWith({ authToken: "token" });
    expect(showCopyPasteInstructions).toHaveBeenCalledWith(
      expect.objectContaining({
        codeSnippet: expect.stringMatching(
          /^wrangler deploy --outdir .* --upload-source-maps && npm run sentry:sourcemaps$/,
        ),
      }),
    );
  });

  it("installs the sentry CLI major the wizard runs on", async () => {
    usePackageJson({ "sentry:sourcemaps": "echo existing" });
    selectMock.mockResolvedValueOnce(false);

    await expect(configureWrangler(options)).rejects.toThrow(WizardExitError);
    expect(installPackage).toHaveBeenCalledWith(
      expect.objectContaining({ packageName: SENTRY_CLI_PACKAGE_SPEC }),
    );
  });
});
