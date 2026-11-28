import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPackageDotJson: vi.fn(),
  installPackage: vi.fn(),
  printSdkV11MigrationGuideIfOutdated: vi.fn(),
  setTag: vi.fn(),
}));

vi.mock("../../../../../src/lib/wizard/utils/clack/index.js", () => ({
  getPackageDotJson: mocks.getPackageDotJson,
  installPackage: mocks.installPackage,
  printSdkV11MigrationGuideIfOutdated:
    mocks.printSdkV11MigrationGuideIfOutdated,
}));

vi.mock("../../../../../src/lib/wizard/telemetry.js", () => ({
  Sentry: { setTag: mocks.setTag },
}));

import { ensureBundlerPlugin } from "../../../../../src/lib/wizard/sourcemaps/utils/bundler-plugin.js";

type Deps = Record<string, string>;

function mockPackageJson(before: Deps, after: Deps = before) {
  mocks.getPackageDotJson
    .mockResolvedValueOnce({ dependencies: before })
    .mockResolvedValueOnce({ dependencies: after });
}

describe("ensureBundlerPlugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Drop queued once-values left over from tests that read package.json
    // only once.
    mocks.getPackageDotJson.mockReset();
    mocks.installPackage.mockResolvedValue({});
  });

  it("installs @sentry/bundler-plugins as a dev dependency when no SDK ships the plugin", async () => {
    mockPackageJson({ "@sentry/browser": "^11.0.0" });

    const importPath = await ensureBundlerPlugin("vite");

    expect(importPath).toBe("@sentry/bundler-plugins/vite");
    expect(mocks.installPackage).toHaveBeenCalledTimes(1);
    expect(mocks.installPackage).toHaveBeenCalledWith({
      packageName: "@sentry/bundler-plugins@^11",
      packageNameDisplayLabel: "@sentry/bundler-plugins",
      alreadyInstalled: false,
      devDependency: true,
    });
    expect(mocks.setTag).toHaveBeenCalledWith(
      "bundler-plugin-source",
      "bundler-plugins",
    );
  });

  it("marks @sentry/bundler-plugins as already installed", async () => {
    mockPackageJson({ "@sentry/bundler-plugins": "^11.0.0" });

    await ensureBundlerPlugin("rollup");

    expect(mocks.installPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        packageName: "@sentry/bundler-plugins@^11",
        alreadyInstalled: true,
      }),
    );
  });

  it.each(["vite", "webpack", "rollup", "esbuild"] as const)(
    "imports the %s plugin from @sentry/node when it is installed at v11",
    async (bundler) => {
      mockPackageJson({ "@sentry/node": "^11.0.0" });

      const importPath = await ensureBundlerPlugin(bundler);

      expect(importPath).toBe(`@sentry/node/${bundler}`);
      expect(mocks.installPackage).toHaveBeenCalledTimes(1);
      expect(mocks.installPackage).toHaveBeenCalledWith({
        packageName: "@sentry/node@^11",
        packageNameDisplayLabel: "@sentry/node",
        alreadyInstalled: true,
      });
      expect(mocks.setTag).toHaveBeenCalledWith("bundler-plugin-source", "sdk");
    },
  );

  it("updates an outdated SDK and imports from it after the update", async () => {
    mockPackageJson(
      { "@sentry/node": "^9.0.0" },
      { "@sentry/node": "^11.10.0" },
    );

    const importPath = await ensureBundlerPlugin("vite");

    expect(mocks.printSdkV11MigrationGuideIfOutdated).toHaveBeenCalledWith(
      "@sentry/node",
      { dependencies: { "@sentry/node": "^9.0.0" } },
    );
    expect(importPath).toBe("@sentry/node/vite");
  });

  it("falls back to @sentry/bundler-plugins when the SDK update is declined", async () => {
    mockPackageJson({ "@sentry/node": "^9.0.0" });

    const importPath = await ensureBundlerPlugin("vite");

    expect(importPath).toBe("@sentry/bundler-plugins/vite");
    expect(mocks.installPackage).toHaveBeenCalledTimes(2);
    expect(mocks.installPackage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        packageName: "@sentry/bundler-plugins@^11",
        devDependency: true,
      }),
    );
  });

  it("imports the webpack plugin from @sentry/nestjs", async () => {
    mockPackageJson({
      "@sentry/nestjs": "^11.10.0",
      "@sentry/node": "^11.10.0",
    });

    const importPath = await ensureBundlerPlugin("webpack");

    expect(importPath).toBe("@sentry/nestjs/webpack");
  });

  it("falls back when @sentry/nestjs stays on a version without the webpack subpath", async () => {
    mockPackageJson({ "@sentry/nestjs": "^11.5.0" });

    const importPath = await ensureBundlerPlugin("webpack");

    expect(importPath).toBe("@sentry/bundler-plugins/webpack");
  });

  it("uses @sentry/node for bundlers that @sentry/nestjs does not ship", async () => {
    mockPackageJson({
      "@sentry/nestjs": "^11.10.0",
      "@sentry/node": "^11.10.0",
    });

    const importPath = await ensureBundlerPlugin("vite");

    expect(importPath).toBe("@sentry/node/vite");
  });

  it("installs @sentry/bundler-plugins for bundlers the installed SDK does not ship", async () => {
    mockPackageJson({ "@sentry/aws-serverless": "^11.10.0" });

    const importPath = await ensureBundlerPlugin("vite");

    expect(importPath).toBe("@sentry/bundler-plugins/vite");
    expect(mocks.installPackage).toHaveBeenCalledTimes(1);
  });

  it("imports the esbuild plugin from @sentry/aws-serverless", async () => {
    mockPackageJson({ "@sentry/aws-serverless": "^11.10.0" });

    const importPath = await ensureBundlerPlugin("esbuild");

    expect(importPath).toBe("@sentry/aws-serverless/esbuild");
  });
});
