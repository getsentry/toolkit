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
  getPackageDotJson: vi.fn().mockResolvedValue({
    scripts: {
      build: "remix build",
    },
    version: "1.0.0",
  }),
}));

describe("updateBuildScript", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uploads with sentry sourcemap upload", async () => {
    await updateBuildScript({ isHydrogen: false });

    expect(JSON.parse(writeFileSpy.mock.calls[0]?.[1] as string)).toEqual({
      scripts: {
        build:
          'remix build --sourcemap && sentry sourcemap upload ./public/build --url-prefix "~/build/"',
      },
      version: "1.0.0",
    });
  });

  it("uploads ./dist for hydrogen apps", async () => {
    vi.mocked(getPackageDotJson).mockResolvedValue({
      scripts: {
        build: "shopify hydrogen build",
      },
      version: "1.0.0",
    });

    await updateBuildScript({ isHydrogen: true });

    expect(writeFileSpy).toHaveBeenCalledWith(
      expect.stringContaining("package.json"),
      expect.stringContaining(
        'shopify hydrogen build --sourcemap && sentry sourcemap upload ./dist --url-prefix \\"~/build/\\"',
      ),
    );
  });

  it("sets build script when none exists", async () => {
    vi.mocked(getPackageDotJson).mockResolvedValue({
      scripts: {},
      version: "1.0.0",
    });

    await updateBuildScript({ isHydrogen: false });

    expect(writeFileSpy).toHaveBeenCalledWith(
      expect.stringContaining("package.json"),
      expect.stringContaining(
        "remix build --sourcemap && sentry sourcemap upload ./public/build",
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

    await expect(updateBuildScript({ isHydrogen: false })).rejects.toThrow(
      "build` script doesn't contain a known build command",
    );
  });
});
