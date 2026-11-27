import { describe, expect, it, vi, beforeEach } from "vitest";

const { clackMocks } = vi.hoisted(() => {
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  const success = vi.fn();
  const outro = vi.fn();
  const confirm = vi.fn(() => Promise.resolve(false)); // default to false for tests

  return {
    clackMocks: {
      info,
      warn,
      error,
      success,
      outro,
      confirm,
    },
  };
});

vi.mock("@clack/prompts", () => {
  return {
    __esModule: true,
    log: {
      info: clackMocks.info,
      warn: clackMocks.warn,
      error: clackMocks.error,
      success: clackMocks.success,
    },
    outro: clackMocks.outro,
    confirm: clackMocks.confirm,
  };
});

const { existsSyncMock, readFileSyncMock, writeFileSyncMock } = vi.hoisted(
  () => {
    return {
      existsSyncMock: vi.fn(),
      readFileSyncMock: vi.fn(),
      writeFileSyncMock: vi.fn(),
    };
  },
);

const { getPackageDotJsonMock, getPackageVersionMock } = vi.hoisted(() => ({
  getPackageDotJsonMock: vi.fn(),
  getPackageVersionMock: vi.fn(),
}));

vi.mock("../../../../src/lib/wizard/utils/package-json.js", () => ({
  getPackageDotJson: getPackageDotJsonMock,
  getPackageVersion: getPackageVersionMock,
}));

vi.mock("node:fs", async () => {
  return {
    ...(await vi.importActual("node:fs")),
    existsSync: existsSyncMock,
    readFileSync: readFileSyncMock,
    writeFileSync: writeFileSyncMock,
    promises: {
      writeFile: vi.fn(),
    },
  };
});

// module-level mock for child_process.execSync
vi.mock("node:child_process", () => ({
  __esModule: true,
  execSync: vi.fn(),
}));

// mock showCopyPasteInstructions and makeCodeSnippet used by templates
vi.mock("../../../../src/lib/wizard/utils/clack/index.js", () => {
  return {
    __esModule: true,
    showCopyPasteInstructions: vi.fn(() => Promise.resolve()),
    makeCodeSnippet: vi.fn(
      (
        _colors: boolean,
        callback: (
          unchanged: (str: string) => string,
          plus: (str: string) => string,
          minus: (str: string) => string,
        ) => string,
      ) => {
        // Mock implementation that just calls the callback with simple string functions
        const unchanged = (str: string) => str;
        const plus = (str: string) => `+ ${str}`;
        const minus = (str: string) => `- ${str}`;
        return callback(unchanged, plus, minus);
      },
    ),
    getPackageDotJson: getPackageDotJsonMock,
    // Same contract as the real helper: a cancelled prompt stops the wizard.
    abortIfCancelled: vi.fn(async (input: unknown) => {
      const value = await input;
      if (typeof value === "symbol") {
        const { WizardExitError } =
          await import("../../../../src/lib/errors.js");
        throw new WizardExitError(0);
      }
      return value;
    }),
  };
});

import {
  isReactRouterV7,
  getReactRouterVersion,
  supportsInstrumentationAPI,
  supportsOnError,
  runReactRouterReveal,
  createServerInstrumentationFile,
  tryRevealAndGetManualInstructions,
  updatePackageJsonScripts,
} from "../../../../src/lib/wizard/react-router/sdk-setup.js";
import { execSync } from "node:child_process";
import type { Mock } from "vitest";
import { WizardExitError } from "../../../../src/lib/errors.js";
import { getSentryInstrumentationServerContent } from "../../../../src/lib/wizard/react-router/templates.js";

describe("React Router SDK Setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetAllMocks();

    getPackageVersionMock.mockImplementation(
      (
        packageName: string,
        packageJson: {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        },
      ) => {
        if (packageJson.dependencies?.[packageName]) {
          return packageJson.dependencies[packageName];
        }
        if (packageJson.devDependencies?.[packageName]) {
          return packageJson.devDependencies[packageName];
        }
        return null;
      },
    );
  });

  describe("isReactRouterV7", () => {
    it("should return true for React Router v7+ in dependencies or devDependencies", () => {
      expect(
        isReactRouterV7({ dependencies: { "@react-router/dev": "7.0.0" } }),
      ).toBe(true);
      expect(
        isReactRouterV7({ dependencies: { "@react-router/dev": "^7.1.0" } }),
      ).toBe(true);
      expect(
        isReactRouterV7({
          devDependencies: { "@react-router/dev": "7.1.0" },
        }),
      ).toBe(true);
    });

    it("should return false for React Router v6 or missing dependency", () => {
      expect(
        isReactRouterV7({ dependencies: { "@react-router/dev": "6.28.0" } }),
      ).toBe(false);
      expect(isReactRouterV7({ dependencies: { react: "^18.0.0" } })).toBe(
        false,
      );
      expect(isReactRouterV7({})).toBe(false);
    });
  });

  describe("getReactRouterVersion", () => {
    it("should coerce range version from package.json", () => {
      expect(
        getReactRouterVersion({
          dependencies: { "@react-router/dev": "^7.8.2" },
        }),
      ).toBe("7.8.2");
    });

    it("should return undefined when package is not in package.json", () => {
      expect(
        getReactRouterVersion({ dependencies: { react: "^18.0.0" } }),
      ).toBeUndefined();
      expect(getReactRouterVersion({})).toBeUndefined();
    });
  });

  describe("supportsInstrumentationAPI", () => {
    it("should return true for React Router v7.15.0 or higher", () => {
      expect(
        supportsInstrumentationAPI({
          dependencies: { "@react-router/dev": "7.15.0" },
        }),
      ).toBe(true);
      expect(
        supportsInstrumentationAPI({
          dependencies: { "@react-router/dev": "^7.15.0" },
        }),
      ).toBe(true);
      expect(
        supportsInstrumentationAPI({
          dependencies: { "@react-router/dev": "7.16.0" },
        }),
      ).toBe(true);
      expect(
        supportsInstrumentationAPI({
          dependencies: { "@react-router/dev": "8.0.0" },
        }),
      ).toBe(true);
      expect(
        supportsInstrumentationAPI({
          devDependencies: { "@react-router/dev": "7.15.0" },
        }),
      ).toBe(true);
    });

    it("should return false for React Router versions below v7.15.0", () => {
      expect(
        supportsInstrumentationAPI({
          dependencies: { "@react-router/dev": "7.14.0" },
        }),
      ).toBe(false);
      expect(
        supportsInstrumentationAPI({
          dependencies: { "@react-router/dev": "7.0.0" },
        }),
      ).toBe(false);
      expect(
        supportsInstrumentationAPI({
          dependencies: { "@react-router/dev": "7.9.5" },
        }),
      ).toBe(false);
    });

    it("should return false when @react-router/dev is not installed", () => {
      expect(
        supportsInstrumentationAPI({
          dependencies: { react: "^18.0.0" },
        }),
      ).toBe(false);
      expect(supportsInstrumentationAPI({})).toBe(false);
    });

    it("should handle semver range specifiers correctly", () => {
      expect(
        supportsInstrumentationAPI({
          dependencies: { "@react-router/dev": "~7.15.0" },
        }),
      ).toBe(true);
      expect(
        supportsInstrumentationAPI({
          dependencies: { "@react-router/dev": ">=7.15.0" },
        }),
      ).toBe(true);
    });
  });

  describe("supportsOnError", () => {
    it("should return true for React Router v7.11.0 or higher", () => {
      expect(
        supportsOnError({
          dependencies: { "@react-router/dev": "7.11.0" },
        }),
      ).toBe(true);
      expect(
        supportsOnError({
          dependencies: { "@react-router/dev": "^7.11.0" },
        }),
      ).toBe(true);
      expect(
        supportsOnError({
          dependencies: { "@react-router/dev": "7.12.0" },
        }),
      ).toBe(true);
      expect(
        supportsOnError({
          dependencies: { "@react-router/dev": "8.0.0" },
        }),
      ).toBe(true);
      expect(
        supportsOnError({
          devDependencies: { "@react-router/dev": "7.11.0" },
        }),
      ).toBe(true);
    });

    it("should return false for React Router versions below v7.11.0", () => {
      expect(
        supportsOnError({
          dependencies: { "@react-router/dev": "7.10.0" },
        }),
      ).toBe(false);
      expect(
        supportsOnError({
          dependencies: { "@react-router/dev": "7.0.0" },
        }),
      ).toBe(false);
      expect(
        supportsOnError({
          dependencies: { "@react-router/dev": "7.8.2" },
        }),
      ).toBe(false);
    });

    it("should return false when @react-router/dev is not installed", () => {
      expect(
        supportsOnError({
          dependencies: { react: "^18.0.0" },
        }),
      ).toBe(false);
      expect(supportsOnError({})).toBe(false);
    });
  });

  describe("generateServerInstrumentation", () => {
    it("should generate server instrumentation file with all features enabled", () => {
      const dsn = "https://sentry.io/123";
      const enableTracing = true;
      const enableProfiling = false;

      const result = getSentryInstrumentationServerContent(
        dsn,
        enableTracing,
        enableProfiling,
        false,
      );

      expect(result).toContain('dsn: "https://sentry.io/123"');
      expect(result).toContain("tracesSampleRate: 1");
    });

    it("should generate server instrumentation file when performance is disabled", () => {
      const dsn = "https://sentry.io/123";
      const enableTracing = false;
      const enableProfiling = false;

      const result = getSentryInstrumentationServerContent(
        dsn,
        enableTracing,
        enableProfiling,
        false,
      );

      expect(result).toContain('dsn: "https://sentry.io/123"');
      expect(result).toContain("tracesSampleRate: 0");
    });
  });
});

describe("runReactRouterReveal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetAllMocks();
  });

  it("runs the reveal CLI when entry files are missing", () => {
    existsSyncMock.mockReturnValue(false);

    (execSync as unknown as Mock).mockImplementation(() => "ok");

    runReactRouterReveal();

    expect(execSync).toHaveBeenCalledWith("npx react-router reveal", {
      encoding: "utf8",
      stdio: "pipe",
    });
  });

  it("does not run the reveal CLI when entry files already exist", () => {
    existsSyncMock.mockReturnValue(true);

    (execSync as unknown as Mock).mockReset();

    runReactRouterReveal();

    expect(execSync).not.toHaveBeenCalled();
  });
});

describe("server instrumentation helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetAllMocks();
  });

  it("createServerInstrumentationFile writes instrumentation file and returns path", () => {
    writeFileSyncMock.mockImplementation(() => undefined);

    const path = createServerInstrumentationFile(
      "https://sentry.io/123",
      {
        performance: true,
        replay: false,
        profiling: false,
      },
      false,
    );

    expect(path).toContain("instrument.server.mjs");
    expect(writeFileSyncMock).toHaveBeenCalled();
    const writtenCall = writeFileSyncMock.mock.calls[0] as unknown as [
      string,
      string,
    ];
    expect(writtenCall[0]).toEqual(
      expect.stringContaining("instrument.server.mjs"),
    );
    expect(writtenCall[1]).toEqual(
      expect.stringContaining('dsn: "https://sentry.io/123"'),
    );
    expect(writtenCall[1]).toEqual(
      expect.stringContaining("tracesSampleRate: 1"),
    );
  });
});

describe("tryRevealAndGetManualInstructions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetAllMocks();
  });

  it("should return true when user confirms and reveal command succeeds", async () => {
    const missingFilename = "entry.client.tsx";
    const filePath = "/app/entry.client.tsx";

    // Mock user confirming the reveal operation
    clackMocks.confirm.mockResolvedValueOnce(true);

    // Mock execSync succeeding
    (execSync as unknown as Mock).mockReturnValueOnce(
      "Successfully generated entry files",
    );

    // Mock file existing after reveal
    existsSyncMock.mockReturnValueOnce(true);

    const result = await tryRevealAndGetManualInstructions(
      missingFilename,
      filePath,
    );

    expect(result).toBe(true);
    expect(clackMocks.confirm).toHaveBeenCalledWith({
      message: expect.stringContaining(
        "Would you like to try running",
      ) as string,
      initialValue: true,
    });
    expect(clackMocks.info).toHaveBeenCalledWith(
      expect.stringContaining("Running"),
    );
    expect(execSync).toHaveBeenCalledWith("npx react-router reveal", {
      encoding: "utf8",
      stdio: "pipe",
    });
    expect(clackMocks.success).toHaveBeenCalledWith(
      expect.stringContaining("Found entry.client.tsx after running reveal"),
    );
  });

  it("stops the wizard without running reveal when the prompt is cancelled", async () => {
    clackMocks.confirm.mockResolvedValueOnce(
      Symbol("clack:cancel") as unknown as boolean,
    );

    await expect(
      tryRevealAndGetManualInstructions(
        "entry.client.tsx",
        "/app/entry.client.tsx",
      ),
    ).rejects.toThrow(WizardExitError);
    expect(execSync).not.toHaveBeenCalled();
  });

  it("should return false when user declines reveal operation", async () => {
    const missingFilename = "entry.server.tsx";
    const filePath = "/app/entry.server.tsx";

    // Mock user declining the reveal operation
    clackMocks.confirm.mockResolvedValueOnce(false);

    const result = await tryRevealAndGetManualInstructions(
      missingFilename,
      filePath,
    );

    expect(result).toBe(false);
    expect(clackMocks.confirm).toHaveBeenCalled();
    expect(execSync).not.toHaveBeenCalled();
    expect(clackMocks.info).not.toHaveBeenCalled();
  });

  it("should return false when reveal command succeeds but file still does not exist", async () => {
    const missingFilename = "entry.client.jsx";
    const filePath = "/app/entry.client.jsx";

    // Mock user confirming the reveal operation
    clackMocks.confirm.mockResolvedValueOnce(true);

    // Mock execSync succeeding
    (execSync as unknown as Mock).mockReturnValueOnce("Command output");

    // Mock file NOT existing after reveal
    existsSyncMock.mockReturnValueOnce(false);

    const result = await tryRevealAndGetManualInstructions(
      missingFilename,
      filePath,
    );

    expect(result).toBe(false);
    expect(execSync).toHaveBeenCalled();
    expect(clackMocks.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "entry.client.jsx still not found after running reveal",
      ),
    );
  });

  it("should return false when reveal command throws an error", async () => {
    const missingFilename = "entry.server.jsx";
    const filePath = "/app/entry.server.jsx";

    // Mock user confirming the reveal operation
    clackMocks.confirm.mockResolvedValueOnce(true);

    // Mock execSync throwing an error
    const mockError = new Error("Command failed");
    (execSync as unknown as Mock).mockImplementationOnce(() => {
      throw mockError;
    });

    const result = await tryRevealAndGetManualInstructions(
      missingFilename,
      filePath,
    );

    expect(result).toBe(false);
    expect(execSync).toHaveBeenCalled();
    expect(clackMocks.warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to run npx react-router reveal"),
    );
  });

  it("should log command output when reveal succeeds", async () => {
    const missingFilename = "entry.client.tsx";
    const filePath = "/app/entry.client.tsx";
    const commandOutput = "Generated entry files successfully";

    // Mock user confirming the reveal operation
    clackMocks.confirm.mockResolvedValueOnce(true);

    // Mock execSync succeeding with output
    (execSync as unknown as Mock).mockReturnValueOnce(commandOutput);

    // Mock file existing after reveal
    existsSyncMock.mockReturnValueOnce(true);

    await tryRevealAndGetManualInstructions(missingFilename, filePath);

    expect(clackMocks.info).toHaveBeenCalledWith(commandOutput);
  });

  it("should handle reveal command with proper parameters", async () => {
    const missingFilename = "entry.client.tsx";
    const filePath = "/app/entry.client.tsx";

    // Mock user confirming
    clackMocks.confirm.mockResolvedValueOnce(true);

    // Mock execSync succeeding
    (execSync as unknown as Mock).mockReturnValueOnce("ok");

    // Mock file existing
    existsSyncMock.mockReturnValueOnce(true);

    await tryRevealAndGetManualInstructions(missingFilename, filePath);

    expect(execSync).toHaveBeenCalledWith("npx react-router reveal", {
      encoding: "utf8",
      stdio: "pipe",
    });
  });
});

describe("updatePackageJsonScripts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetAllMocks();
  });

  it("should set NODE_ENV=production for both dev and start scripts (workaround for React Router v7 + React 19 issue)", async () => {
    const mockPackageJson: { scripts: Record<string, string> } = {
      scripts: {
        dev: "react-router dev",
        start: "react-router serve",
        build: "react-router build",
      },
    };

    // Mock getPackageDotJson to return our test package.json
    getPackageDotJsonMock.mockResolvedValue(mockPackageJson);

    // Mock fs.promises.writeFile
    const fsPromises = await import("node:fs");
    const writeFileMock = vi
      .spyOn(fsPromises.promises, "writeFile")
      .mockResolvedValue();

    await updatePackageJsonScripts();

    // Verify writeFile was called
    expect(writeFileMock).toHaveBeenCalled();

    // Check the written package.json content
    const writtenContent = JSON.parse(
      writeFileMock.mock.calls[0]?.[1] as string,
    ) as { scripts: Record<string, string> };

    // Both dev and start scripts should use the correct filenames and commands according to documentation
    expect(writtenContent.scripts["dev"]).toBe(
      "NODE_OPTIONS='--import ./instrument.server.mjs' react-router dev",
    );

    // Start script should have NODE_ENV=production before --import
    expect(writtenContent.scripts["start"]).toBe(
      "NODE_ENV=production NODE_OPTIONS='--import ./instrument.server.mjs' react-router-serve ./build/server/index.js",
    );

    // The build script should remain unchanged
    expect(writtenContent.scripts["build"]).toBe("react-router build");
  });

  it("should handle package.json with only start script", async () => {
    const mockPackageJson: { scripts: Record<string, string> } = {
      scripts: {
        start: "react-router serve",
      },
    };

    // Mock getPackageDotJson to return our test package.json
    getPackageDotJsonMock.mockResolvedValue(mockPackageJson);

    // Mock fs.promises.writeFile
    const fsPromises = await import("node:fs");
    const writeFileMock = vi
      .spyOn(fsPromises.promises, "writeFile")
      .mockResolvedValue();

    await updatePackageJsonScripts();

    // Verify only start script is modified when dev doesn't exist
    const writtenContent = JSON.parse(
      writeFileMock.mock.calls[0]?.[1] as string,
    ) as { scripts: Record<string, string> };
    expect(writtenContent.scripts["start"]).toBe(
      "NODE_ENV=production NODE_OPTIONS='--import ./instrument.server.mjs' react-router-serve ./build/server/index.js",
    );
    expect(writtenContent.scripts["dev"]).toBeUndefined();
  });

  it("should throw error when no start script exists", async () => {
    const mockPackageJson = {
      scripts: {
        build: "react-router build",
      },
    };

    // Mock getPackageDotJson to return package.json without start script
    getPackageDotJsonMock.mockResolvedValue(mockPackageJson);

    await expect(updatePackageJsonScripts()).rejects.toThrow(
      'Could not find a `start` script in your package.json. Please add: "start": "react-router-serve ./build/server/index.js" and re-run the wizard.',
    );
  });

  it("should handle unquoted NODE_OPTIONS in dev script", async () => {
    const mockPackageJson: { scripts: Record<string, string> } = {
      scripts: {
        dev: "NODE_OPTIONS=--loader ts-node/register react-router dev",
        start: "react-router serve",
      },
    };

    getPackageDotJsonMock.mockResolvedValue(mockPackageJson);

    const fsPromises = await import("node:fs");
    const writeFileMock = vi
      .spyOn(fsPromises.promises, "writeFile")
      .mockResolvedValue();

    await updatePackageJsonScripts();

    const writtenContent = JSON.parse(
      writeFileMock.mock.calls[0]?.[1] as string,
    ) as { scripts: Record<string, string> };

    // Should merge unquoted NODE_OPTIONS and wrap result in single quotes
    expect(writtenContent.scripts["dev"]).toBe(
      "NODE_OPTIONS='--loader ts-node/register --import ./instrument.server.mjs' react-router dev",
    );
  });

  it("should handle unquoted NODE_OPTIONS in start script", async () => {
    const mockPackageJson: { scripts: Record<string, string> } = {
      scripts: {
        start:
          "NODE_OPTIONS=--require ./dotenv-config.js react-router-serve ./build/server/index.js",
      },
    };

    getPackageDotJsonMock.mockResolvedValue(mockPackageJson);

    const fsPromises = await import("node:fs");
    const writeFileMock = vi
      .spyOn(fsPromises.promises, "writeFile")
      .mockResolvedValue();

    await updatePackageJsonScripts();

    const writtenContent = JSON.parse(
      writeFileMock.mock.calls[0]?.[1] as string,
    ) as { scripts: Record<string, string> };

    // Should merge unquoted NODE_OPTIONS and prepend NODE_ENV
    expect(writtenContent.scripts["start"]).toBe(
      "NODE_ENV=production NODE_OPTIONS='--require ./dotenv-config.js --import ./instrument.server.mjs' react-router-serve ./build/server/index.js",
    );
  });

  it("should handle quoted NODE_OPTIONS and standardize to single quotes", async () => {
    const mockPackageJson: { scripts: Record<string, string> } = {
      scripts: {
        dev: 'NODE_OPTIONS="--max-old-space-size=4096" react-router dev',
        start: "NODE_OPTIONS='--enable-source-maps' react-router serve",
      },
    };

    getPackageDotJsonMock.mockResolvedValue(mockPackageJson);

    const fsPromises = await import("node:fs");
    const writeFileMock = vi
      .spyOn(fsPromises.promises, "writeFile")
      .mockResolvedValue();

    await updatePackageJsonScripts();

    const writtenContent = JSON.parse(
      writeFileMock.mock.calls[0]?.[1] as string,
    ) as { scripts: Record<string, string> };

    // Should standardize to single quotes
    expect(writtenContent.scripts["dev"]).toBe(
      "NODE_OPTIONS='--max-old-space-size=4096 --import ./instrument.server.mjs' react-router dev",
    );
    // Should prepend NODE_ENV=production to start script
    expect(writtenContent.scripts["start"]).toBe(
      "NODE_ENV=production NODE_OPTIONS='--enable-source-maps --import ./instrument.server.mjs' react-router serve",
    );
  });
});
