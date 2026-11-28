import {
  abort,
  askForToolConfigPath,
  confirmContinueIfNoOrDirtyGitRepo,
  createNewConfigFile,
  getPackageManager,
  installPackage,
  printSdkV11MigrationGuideIfOutdated,
} from "../../../../../src/lib/wizard/utils/clack/index.js";
import { WizardExitError } from "../../../../../src/lib/errors.js";

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as fs from "node:fs";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as ChildProcess from "node:child_process";
import type { PackageManager } from "../../../../../src/lib/wizard/utils/package-manager.js";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as PackageManagerUtils from "../../../../../src/lib/wizard/utils/package-manager.js";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as GitUtils from "../../../../../src/lib/wizard/utils/git.js";

import {
  NPM,
  PNPM,
  YARN_V1,
  YARN_V2,
} from "../../../../../src/lib/wizard/utils/package-manager.js";

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as clack from "@clack/prompts";

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as Sentry from "@sentry/node";

import {
  vi,
  it,
  describe,
  expect,
  beforeEach,
  type Mocked,
  type Mock,
  type MockInstance,
  afterEach,
} from "vitest";

vi.mock("node:child_process", async () => ({
  __esModule: true,
  ...(await vi.importActual<typeof ChildProcess>("node:child_process")),
}));

vi.mock("node:fs", async () => ({
  __esModule: true,
  ...(await vi.importActual<typeof fs>("node:fs")),
}));

vi.mock("@clack/prompts", () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  outro: vi.fn(),
  text: vi.fn(),
  confirm: vi.fn(),
  cancel: vi.fn(),
  // passthrough for abortIfCancelled
  isCancel: vi.fn().mockReturnValue(false),
  spinner: vi
    .fn()
    .mockImplementation(() => ({ start: vi.fn(), stop: vi.fn() })),
  select: vi.fn(),
}));
const clackMock = clack as Mocked<typeof clack>;

vi.mock("../../../../../src/lib/wizard/utils/git.js", () => ({
  isInGitRepo: vi.fn(),
  getUncommittedOrUntrackedFilePaths: vi.fn(),
}));

vi.mock("@sentry/node", async () => {
  const actual =
    await vi.importActual<typeof import("@sentry/node")>("@sentry/node");
  return {
    ...actual,
    setTag: vi.fn(),
    captureException: vi.fn(() => "id"),
  };
});

function mockUserResponse(fn: Mock, response: unknown) {
  fn.mockReturnValueOnce(response);
}

describe("askForToolConfigPath", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns undefined if users have no config file", async () => {
    mockUserResponse(clack.confirm as Mock, false);

    const result = await askForToolConfigPath("Webpack", "webpack.config.js");

    expect(clack.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("have a Webpack config file"),
      }),
    );

    expect(result).toBeUndefined();
  });

  it("returns the path if users have a config file and the entered path is valid", async () => {
    mockUserResponse(clack.confirm as Mock, true);
    mockUserResponse(clack.text as Mock, "my.webpack.config.js");

    const result = await askForToolConfigPath("Webpack", "webpack.config.js");

    expect(clack.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("have a Webpack config file"),
      }),
    );

    expect(clack.text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(
          "enter the path to your Webpack config file",
        ),
      }),
    );

    expect(result).toBe("my.webpack.config.js");
  });
});

describe("createNewConfigFile", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("writes the file to disk and returns true if the file was created successfully", async () => {
    const writeFileSpy = vi
      .spyOn(fs.promises, "writeFile")
      .mockImplementation(vi.fn());

    const filename = "/webpack.config.js";
    const code = "module.exports = {/*config...*/}";

    const result = await createNewConfigFile(filename, code);

    expect(result).toBe(true);
    expect(writeFileSpy).toHaveBeenCalledWith(filename, code);
  });

  it("logs more information if provided as an argument", async () => {
    vi.spyOn(fs.promises, "writeFile").mockImplementation(vi.fn());

    const filename = "/webpack.config.js";
    const code = "module.exports = {/*config...*/}";
    const moreInfo = "More information...";

    await createNewConfigFile(filename, code, moreInfo);

    expect(clack.log.info).toHaveBeenCalledTimes(1);
    expect(clack.log.info).toHaveBeenCalledWith(
      expect.stringContaining(moreInfo),
    );
  });

  it("returns false and logs a warning if the file could not be created", async () => {
    const writeFileSpy = vi
      .spyOn(fs.promises, "writeFile")
      .mockImplementation(() => Promise.reject(new Error("Could not write")));

    const filename = "/webpack.config.js";
    const code = "module.exports = {/*config...*/}";

    const result = await createNewConfigFile(filename, code);

    expect(result).toBe(false);
    expect(writeFileSpy).toHaveBeenCalledWith(filename, code);
    expect(clack.log.warn).toHaveBeenCalledTimes(1);
  });

  it("returns false if the passed path is not absolute", async () => {
    const result = await createNewConfigFile(
      "./relative/webpack.config.js",
      "",
    );

    expect(result).toBe(false);
  });
});

describe("installPackage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  const spawnSpy = vi.spyOn(ChildProcess, "spawn").mockImplementation(() => ({
    // @ts-expect-error - not passing the full object but directly resolving
    // to simulate a successful install
    on: vi.fn((evt: string, cb: (args) => void) => {
      if (evt === "close") {
        cb(0);
      }
    }),
    // @ts-expect-error - this is fine
    stdout: { on: vi.fn() },
    // @ts-expect-error - this is fine
    stderr: { on: vi.fn() },
  }));

  it("force-installs a package if the forceInstall flag is set", async () => {
    const packageManagerMock: PackageManager = {
      name: "npm",
      label: "NPM",
      installCommand: "install",
      buildCommand: "npm run build",
      runScriptCommand: "npm run",
      flags: "",
      forceInstallFlag: "--force",
      detect: vi.fn(),
      addOverride: vi.fn(),
    };

    await installPackage({
      alreadyInstalled: false,
      packageName: "@some/package",
      packageNameDisplayLabel: "@some/package",
      forceInstall: true,
      askBeforeUpdating: false,
      packageManager: packageManagerMock,
    });

    expect(spawnSpy).toHaveBeenCalledWith(
      "npm",
      ["install", "@some/package", "--force"],
      { shell: true, stdio: ["pipe", "pipe", "pipe"] },
    );
  });

  it.each([false, undefined])(
    "doesn't force-install a package if the forceInstall flag is %s",
    async (flag) => {
      const packageManagerMock: PackageManager = {
        name: "npm",
        label: "NPM",
        installCommand: "install",
        buildCommand: "npm run build",
        runScriptCommand: "npm run",
        flags: "",
        forceInstallFlag: "--force",
        detect: vi.fn(),
        addOverride: vi.fn(),
      };

      await installPackage({
        alreadyInstalled: false,
        packageName: "@sentry/sveltekit",
        packageNameDisplayLabel: "@sentry/sveltekit",
        forceInstall: flag,
        askBeforeUpdating: false,
        packageManager: packageManagerMock,
      });

      expect(spawnSpy).toHaveBeenCalledWith(
        "npm",
        ["install", "@sentry/sveltekit"],
        { shell: true, stdio: ["pipe", "pipe", "pipe"] },
      );
    },
  );

  it("adds install flags if defined", async () => {
    const packageManagerMock: PackageManager = {
      name: "npm",
      label: "NPM",
      installCommand: "install",
      buildCommand: "npm run build",
      runScriptCommand: "npm run",
      flags: "--ignore-workspace-root-check",
      forceInstallFlag: "--force",
      detect: vi.fn(),
      addOverride: vi.fn(),
    };

    await installPackage({
      alreadyInstalled: false,
      packageName: "@some/package",
      packageNameDisplayLabel: "@some/package",
      forceInstall: true,
      askBeforeUpdating: false,
      packageManager: packageManagerMock,
    });

    expect(spawnSpy).toHaveBeenCalledWith(
      "npm",

      ["install", "@some/package", "--ignore-workspace-root-check", "--force"],
      { shell: true, stdio: ["pipe", "pipe", "pipe"] },
    );
  });

  it("irgnores stdout when installing with Yarn", async () => {
    await installPackage({
      alreadyInstalled: false,
      packageName: "@sentry/nextjs",
      askBeforeUpdating: false,
      packageManager: YARN_V2,
    });

    expect(spawnSpy).toHaveBeenCalledWith("yarn", ["add", "@sentry/nextjs"], {
      shell: true,
      stdio: ["pipe", "ignore", "pipe"],
    });
  });

  it("shows pnpm 11 build approval guidance before installation", async () => {
    await installPackage({
      alreadyInstalled: false,
      packageName: "@sentry/nextjs",
      askBeforeUpdating: false,
      packageManager: PNPM,
    });

    expect(clack.log.info).toHaveBeenCalledWith(
      expect.stringContaining("pnpm approve-builds"),
    );
  });

  it("writes package manager stdout to the error log file", async () => {
    const output = "ERR_PNPM_IGNORED_BUILDS Ignored build scripts: sharp";
    const writeFileSpy = vi
      .spyOn(fs, "writeFileSync")
      .mockImplementation(vi.fn());
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(123);
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/project");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    spawnSpy.mockImplementationOnce(() => ({
      stdout: {
        on: vi.fn(
          (
            _event: string,
            callback: ((data: string) => void) | (() => void),
          ) => {
            callback(output);
          },
        ),
      } as unknown as ChildProcess.ChildProcess["stdout"],
      // @ts-expect-error - not passing the full ChildProcess object
      stderr: { on: vi.fn() },
      // @ts-expect-error - not passing the full ChildProcess object
      on: vi.fn(
        (event: "error" | "close", callback: (code: number) => void) => {
          if (event === "close") {
            callback(1);
          }
        },
      ),
    }));

    await expect(
      installPackage({
        alreadyInstalled: false,
        packageName: "@sentry/nextjs@^10",
        askBeforeUpdating: false,
        packageManager: PNPM,
      }),
    ).rejects.toThrow(WizardExitError);

    expect(writeFileSpy).toHaveBeenCalledWith(
      "/project/sentry-wizard-installation-error-123.log",
      output,
      { encoding: "utf8" },
    );
    expect(clack.log.error).toHaveBeenCalledWith(
      expect.not.stringContaining(output),
    );
    expect(clack.log.error).toHaveBeenCalledWith(
      expect.stringContaining("sentry-wizard-installation-error-*.log"),
    );

    writeFileSpy.mockRestore();
    dateSpy.mockRestore();
    cwdSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe("printSdkV11MigrationGuideIfOutdated", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each(["^10.0.0", "10.5.2", "~9.1.0", ">=8.0.0 <11.0.0"])(
    "warns and links the migration guide for the installed range %s",
    (version) => {
      printSdkV11MigrationGuideIfOutdated("@sentry/nextjs", {
        dependencies: { "@sentry/nextjs": version },
      });

      expect(clackMock.log.warn).toHaveBeenCalledTimes(1);
      expect(clackMock.log.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "https://docs.sentry.io/platforms/javascript/guides/nextjs/migration/v10-to-v11/",
        ),
      );
    },
  );

  it.each([
    ["@sentry/angular", "angular"],
    ["@sentry/cloudflare", "cloudflare"],
    ["@sentry/nextjs", "nextjs"],
    ["@sentry/nuxt", "nuxt"],
    ["@sentry/react-router", "react-router"],
    ["@sentry/remix", "remix"],
    ["@sentry/sveltekit", "sveltekit"],
  ])("links the %s migration guide", (packageName, guide) => {
    printSdkV11MigrationGuideIfOutdated(packageName, {
      dependencies: { [packageName]: "^10.2.0" },
    });

    expect(clackMock.log.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        `https://docs.sentry.io/platforms/javascript/guides/${guide}/migration/v10-to-v11/`,
      ),
    );
  });

  it("falls back to the generic migration guide for other SDKs", () => {
    printSdkV11MigrationGuideIfOutdated("@sentry/browser", {
      dependencies: { "@sentry/browser": "^10.0.0" },
    });

    expect(clackMock.log.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "https://docs.sentry.io/platforms/javascript/migration/v10-to-v11/",
      ),
    );
  });

  it.each([
    ["the SDK is not installed", {}],
    [
      "the SDK is already on v11",
      { dependencies: { "@sentry/nextjs": "^11.0.0" } },
    ],
    [
      "the installed range is not a valid semver range",
      {
        dependencies: { "@sentry/nextjs": "workspace:*" },
      },
    ],
  ])("stays silent when %s", (_case, packageJson) => {
    printSdkV11MigrationGuideIfOutdated("@sentry/nextjs", packageJson);

    expect(clackMock.log.warn).not.toHaveBeenCalled();
  });
});

describe("abort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stops the wizard with an error exit code by default", async () => {
    const error = await abort().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WizardExitError);
    expect((error as WizardExitError).exitCode).toBe(1);
    expect(clackMock.outro).toHaveBeenCalledTimes(1);
    expect(clackMock.outro).toHaveBeenCalledWith("Wizard setup cancelled.");
    expect(Sentry.setTag).toHaveBeenCalledWith("wizard.outcome", "aborted");
  });

  it("stops the wizard with a custom exit code and message if provided", async () => {
    const error = await abort("Bye", 0).catch((e: unknown) => e);

    expect((error as WizardExitError).exitCode).toBe(0);
    expect(clackMock.outro).toHaveBeenCalledTimes(1);
    expect(clackMock.outro).toHaveBeenCalledWith("Bye");
    expect(Sentry.setTag).toHaveBeenCalledWith("wizard.outcome", "cancelled");
  });
});

describe("getPackageManager", () => {
  afterEach(() => {
    vi.clearAllMocks();
    // @ts-expect-error - this variable is set by the wizard
    delete global.__sentry_wizard_cached_package_manager;
  });

  it("returns the auto-detected package manager", async () => {
    const detectPacManSpy = vi
      .spyOn(PackageManagerUtils, "_detectPackageManger")
      .mockReturnValueOnce(YARN_V1);

    const packageManager = await getPackageManager();

    expect(detectPacManSpy).toHaveBeenCalledTimes(1);

    expect(packageManager).toBe(YARN_V1);
  });

  it("caches the auto-detected package manager", async () => {
    const detectPacManSpy = vi
      .spyOn(PackageManagerUtils, "_detectPackageManger")
      .mockReturnValueOnce(YARN_V1);

    const packageManager1 = await getPackageManager();
    const packageManager2 = await getPackageManager();

    expect(detectPacManSpy).toHaveBeenCalledTimes(1);

    expect(packageManager1).toBe(YARN_V1);
    expect(packageManager2).toBe(YARN_V1);
  });

  describe("when auto detection fails", () => {
    it("returns a fallback package manager if fallback is specified", async () => {
      const detectPacManSpy = vi
        .spyOn(PackageManagerUtils, "_detectPackageManger")
        .mockReturnValueOnce(null);

      const packageManager = await getPackageManager(YARN_V2);

      expect(detectPacManSpy).toHaveBeenCalledTimes(1);

      expect(packageManager).toBe(YARN_V2);
    });

    it("doesn't cache the fallback package manager", async () => {
      const detectPacManSpy = vi
        .spyOn(PackageManagerUtils, "_detectPackageManger")
        .mockReturnValue(null);

      const packageManager1 = await getPackageManager(YARN_V2);
      const packageManager2 = await getPackageManager(NPM);

      expect(detectPacManSpy).toHaveBeenCalledTimes(2);

      expect(packageManager1).toBe(YARN_V2);
      expect(packageManager2).toBe(NPM);
    });

    it("returns the user-selected package manager if no fallback is provided", async () => {
      const detectPacManSpy = vi
        .spyOn(PackageManagerUtils, "_detectPackageManger")
        .mockReturnValueOnce(null);

      clackMock.select.mockReturnValueOnce(Promise.resolve(PNPM));

      const packageManager = await getPackageManager();

      expect(detectPacManSpy).toHaveBeenCalledTimes(1);
      expect(packageManager).toBe(PNPM);
    });

    it("caches the user-selected package manager", async () => {
      const detectPacManSpy = vi
        .spyOn(PackageManagerUtils, "_detectPackageManger")
        .mockReturnValueOnce(null);

      clackMock.select.mockReturnValueOnce(Promise.resolve(PNPM));

      const packageManager1 = await getPackageManager();
      const packageManager2 = await getPackageManager();

      expect(detectPacManSpy).toHaveBeenCalledTimes(1);
      expect(clackMock.select).toHaveBeenCalledTimes(1);

      expect(packageManager1).toBe(PNPM);
      expect(packageManager2).toBe(PNPM);
    });
  });
});

describe("confirmContinueIfNoOrDirtyGitRepo", () => {
  // process.exit is mocked to throw so that abort() halts execution the same
  // way it would terminate the process in production, instead of falling
  // through to the interactive prompt.
  let exitSpy: MockInstance<typeof process.exit>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Drain any leftover `mockReturnValueOnce` values queued by earlier
    // suites; `clearAllMocks` clears call history but not the once-queue.
    clackMock.confirm.mockReset();
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  describe("non-interactive mode", () => {
    it("aborts without prompting when the project is not a git repository", async () => {
      (GitUtils.isInGitRepo as Mock).mockReturnValue(false);

      await expect(
        confirmContinueIfNoOrDirtyGitRepo({
          ignoreGitChanges: undefined,
          cwd: undefined,
          nonInteractive: true,
        }),
      ).rejects.toThrow(WizardExitError);

      expect(clack.log.error).toHaveBeenCalledWith(
        expect.stringContaining(
          "not inside a git repository in non-interactive mode",
        ),
      );
      expect(Sentry.setTag).toHaveBeenCalledWith("continue-without-git", false);
      expect(clack.confirm).not.toHaveBeenCalled();
    });

    it("aborts without prompting when the repository has uncommitted or untracked files", async () => {
      (GitUtils.isInGitRepo as Mock).mockReturnValue(true);
      (GitUtils.getUncommittedOrUntrackedFilePaths as Mock).mockReturnValue([
        "src/index.ts",
      ]);

      await expect(
        confirmContinueIfNoOrDirtyGitRepo({
          ignoreGitChanges: false,
          cwd: undefined,
          nonInteractive: true,
        }),
      ).rejects.toThrow(WizardExitError);

      expect(clack.log.warn).toHaveBeenCalledWith(
        expect.stringContaining("uncommitted or untracked files"),
      );
      expect(clack.log.error).toHaveBeenCalledWith(
        expect.stringContaining(
          "uncommitted or untracked files in non-interactive mode",
        ),
      );
      expect(Sentry.setTag).toHaveBeenCalledWith(
        "continue-with-dirty-repo",
        false,
      );
      expect(clack.confirm).not.toHaveBeenCalled();
    });
  });

  describe("interactive mode (default)", () => {
    it("prompts to continue when the project is not a git repository", async () => {
      (GitUtils.isInGitRepo as Mock).mockReturnValue(false);
      mockUserResponse(clack.confirm as Mock, true);

      await confirmContinueIfNoOrDirtyGitRepo({
        ignoreGitChanges: undefined,
        cwd: undefined,
      });

      expect(clack.confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("not inside a git repository"),
        }),
      );
      expect(clack.log.error).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(Sentry.setTag).toHaveBeenCalledWith("continue-without-git", true);
    });

    it("prompts to continue when the repository has uncommitted or untracked files", async () => {
      (GitUtils.isInGitRepo as Mock).mockReturnValue(true);
      (GitUtils.getUncommittedOrUntrackedFilePaths as Mock).mockReturnValue([
        "src/index.ts",
      ]);
      mockUserResponse(clack.confirm as Mock, true);

      await confirmContinueIfNoOrDirtyGitRepo({
        ignoreGitChanges: false,
        cwd: undefined,
        nonInteractive: false,
      });

      expect(clack.log.warn).toHaveBeenCalledWith(
        expect.stringContaining("uncommitted or untracked files"),
      );
      expect(clack.confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("continue anyway"),
        }),
      );
      expect(clack.log.error).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(Sentry.setTag).toHaveBeenCalledWith(
        "continue-with-dirty-repo",
        true,
      );
    });

    it("does not prompt or abort for a clean git repository", async () => {
      (GitUtils.isInGitRepo as Mock).mockReturnValue(true);
      (GitUtils.getUncommittedOrUntrackedFilePaths as Mock).mockReturnValue([]);

      await confirmContinueIfNoOrDirtyGitRepo({
        ignoreGitChanges: undefined,
        cwd: undefined,
      });

      expect(clack.confirm).not.toHaveBeenCalled();
      expect(clack.log.warn).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });
});
