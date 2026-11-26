import { beforeEach, describe, expect, it, vi } from "vitest";
import { SemVer } from "semver";
import { addNuxtOverrides } from "../../../../src/lib/wizard/nuxt/sdk-setup.js";
import type { PackageManager } from "../../../../src/lib/wizard/utils/package-manager.js";

const { askShouldAddPackageOverrideMock } = vi.hoisted(() => ({
  askShouldAddPackageOverrideMock: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  log: { warn: vi.fn() },
}));

vi.mock("../../../../src/lib/wizard/utils/clack/index.js", async () => ({
  ...(await vi.importActual("../../../../src/lib/wizard/utils/clack/index.js")),
  askShouldAddPackageOverride: askShouldAddPackageOverrideMock,
}));

describe("addNuxtOverrides", () => {
  const addOverride = vi.fn();
  const packageManager = { addOverride } as unknown as PackageManager;

  beforeEach(() => {
    vi.clearAllMocks();
    askShouldAddPackageOverrideMock.mockResolvedValue(true);
  });

  it("adds an ofetch override for Nuxt < 3.14.0", async () => {
    await addNuxtOverrides(packageManager, new SemVer("3.13.2"));

    expect(askShouldAddPackageOverrideMock).toHaveBeenCalledWith(
      "ofetch",
      "^1.4.0",
    );
    expect(addOverride).toHaveBeenCalledWith("ofetch", "^1.4.0");
  });

  it("does not add the override if the user declines", async () => {
    askShouldAddPackageOverrideMock.mockResolvedValue(false);

    await addNuxtOverrides(packageManager, new SemVer("3.13.2"));

    expect(addOverride).not.toHaveBeenCalled();
  });

  it.each(["3.14.0", "4.0.0"])(
    "does not prompt for Nuxt %s",
    async (version) => {
      await addNuxtOverrides(packageManager, new SemVer(version));

      expect(askShouldAddPackageOverrideMock).not.toHaveBeenCalled();
      expect(addOverride).not.toHaveBeenCalled();
    },
  );

  it("does not prompt if the Nuxt version is unknown", async () => {
    await addNuxtOverrides(packageManager, null);

    expect(askShouldAddPackageOverrideMock).not.toHaveBeenCalled();
  });
});
