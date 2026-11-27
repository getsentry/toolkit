import { promises } from "node:fs";

import { updateBuildScript } from "../../../../src/lib/wizard/remix/sdk-setup.js";
import { getPackageDotJson } from "../../../../src/lib/wizard/utils/clack/index.js";

import { vi, it, describe, expect, afterEach } from "vitest";

const writeFileSpy = vi
  .spyOn(promises, "writeFile")
  .mockImplementation(() => Promise.resolve());

vi.mock("@clack/prompts", () => {
  const mock = {
    log: {
      info: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
    },
    confirm: vi.fn().mockResolvedValue(true),
    isCancel: vi.fn().mockReturnValue(false),
  };
  return { ...mock, default: mock };
});

vi.mock("../../../../src/lib/wizard/utils/clack/index.js", async () => ({
  ...(await vi.importActual("../../../../src/lib/wizard/utils/clack/index.js")),
  // A fresh object per call: updateBuildScript mutates the one it gets.
  getPackageDotJson: vi.fn(() =>
    Promise.resolve({
      scripts: {
        build: "remix build",
      },
      version: "1.0.0",
    }),
  ),
}));

describe("updateBuildScript", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses npx @sentry/remix --upload-sourcemaps for the upload command", async () => {
    await updateBuildScript({
      org: "my-org",
      project: "my-project",
      isHydrogen: false,
    });

    expect(writeFileSpy).toHaveBeenCalledWith(
      expect.stringContaining("package.json"),
      expect.stringContaining(
        "npx @sentry/remix --upload-sourcemaps --org my-org --project my-project",
      ),
    );
  });

  it("replaces the remix build command with sourcemap flag and upload", async () => {
    await updateBuildScript({
      org: "my-org",
      project: "my-project",
      isHydrogen: false,
    });

    expect(writeFileSpy).toHaveBeenCalledWith(
      expect.stringContaining("package.json"),
      expect.stringContaining(
        "remix build --sourcemap && npx @sentry/remix --upload-sourcemaps",
      ),
    );
  });

  it("includes --url flag when a custom url is provided", async () => {
    await updateBuildScript({
      org: "my-org",
      project: "my-project",
      url: "https://self-hosted.example.com",
      isHydrogen: false,
    });

    expect(writeFileSpy).toHaveBeenCalledWith(
      expect.stringContaining("package.json"),
      expect.stringContaining("--url https://self-hosted.example.com"),
    );
  });

  it("uses shopify hydrogen build for hydrogen apps", async () => {
    vi.mocked(getPackageDotJson).mockResolvedValue({
      scripts: {
        build: "shopify hydrogen build",
      },
      version: "1.0.0",
    });

    await updateBuildScript({
      org: "my-org",
      project: "my-project",
      isHydrogen: true,
    });

    expect(writeFileSpy).toHaveBeenCalledWith(
      expect.stringContaining("package.json"),
      expect.stringContaining(
        "shopify hydrogen build --sourcemap && npx @sentry/remix --upload-sourcemaps --org my-org --project my-project --buildPath ./dist",
      ),
    );
  });

  it("sets build script when none exists", async () => {
    vi.mocked(getPackageDotJson).mockResolvedValue({
      scripts: {},
      version: "1.0.0",
    });

    await updateBuildScript({
      org: "my-org",
      project: "my-project",
      isHydrogen: false,
    });

    expect(writeFileSpy).toHaveBeenCalledWith(
      expect.stringContaining("package.json"),
      expect.stringContaining(
        "remix build --sourcemap && npx @sentry/remix --upload-sourcemaps",
      ),
    );
  });

  it("throws when build script has an unknown command", async () => {
    vi.mocked(getPackageDotJson).mockResolvedValue({
      scripts: {
        build: "some-custom-build-tool",
      },
      version: "1.0.0",
    });

    await expect(
      updateBuildScript({
        org: "my-org",
        project: "my-project",
        isHydrogen: false,
      }),
    ).rejects.toThrow("build` script doesn't contain a known build command");
  });

  it("leaves an already instrumented build script alone on a re-run", async () => {
    vi.mocked(getPackageDotJson).mockResolvedValueOnce({
      scripts: {
        build:
          "remix build --sourcemap && npx @sentry/remix --upload-sourcemaps --org my-org --project my-project",
      },
      version: "1.0.0",
    });

    await updateBuildScript({
      org: "my-org",
      project: "my-project",
      isHydrogen: false,
    });

    expect(writeFileSpy).not.toHaveBeenCalled();
  });
});
