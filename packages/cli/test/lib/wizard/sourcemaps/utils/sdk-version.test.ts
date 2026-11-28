import { beforeEach, describe, expect, it, vi } from "vitest";

const clackMocks = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  select: vi.fn(),
  getPackageDotJson: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  log: {
    warn: clackMocks.warn,
    info: clackMocks.info,
  },
  select: clackMocks.select,
}));

vi.mock("../../../../../src/lib/wizard/utils/clack/index.js", () => ({
  abortIfCancelled: vi.fn((v: unknown) => v),
  getPackageDotJson: clackMocks.getPackageDotJson,
  installPackage: vi.fn(),
}));

import { ensureMinimumSdkVersionIsInstalled } from "../../../../../src/lib/wizard/sourcemaps/utils/sdk-version.js";

describe("ensureMinimumSdkVersionIsInstalled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    "11.0.0-beta.2",
    "^11.0.0-beta.2",
    "11.0.0-rc.1",
    "8.0.0-alpha.1",
    "10.74.0",
    "^7.47.0",
  ])("does not warn for SDK version %s", async (version) => {
    clackMocks.getPackageDotJson.mockResolvedValue({
      dependencies: { "@sentry/browser": version },
    });

    await ensureMinimumSdkVersionIsInstalled();

    expect(clackMocks.warn).not.toHaveBeenCalled();
    expect(clackMocks.select).not.toHaveBeenCalled();
  });

  it.each(["7.46.0", "^7.0.0", "6.19.7"])(
    "warns for outdated SDK version %s",
    async (version) => {
      clackMocks.getPackageDotJson.mockResolvedValue({
        dependencies: { "@sentry/browser": version },
      });
      clackMocks.select.mockResolvedValue(false);

      await ensureMinimumSdkVersionIsInstalled();

      expect(clackMocks.warn).toHaveBeenCalledWith(
        expect.stringContaining("outdated version"),
      );
    },
  );
});
