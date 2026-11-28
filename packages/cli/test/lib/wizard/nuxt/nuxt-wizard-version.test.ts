import { describe, expect, it, vi } from "vitest";

import { WizardExitError } from "../../../../src/lib/errors.js";
import { runNuxtWizard } from "../../../../src/lib/wizard/nuxt/nuxt-wizard.js";
import { getOrAskForProjectData } from "../../../../src/lib/wizard/utils/clack/index.js";
import { clack } from "../../../../src/lib/wizard/utils/clack/prompts.js";

vi.mock("../../../../src/lib/wizard/telemetry.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withTelemetry: (_options: unknown, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("../../../../src/lib/wizard/utils/node-version.js", () => ({
  warnIfNodeVersionUnsupportedBySdkV11: vi.fn(),
}));

vi.mock(
  "../../../../src/lib/wizard/utils/clack/index.js",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    printWelcome: vi.fn(),
    confirmContinueIfNoOrDirtyGitRepo: vi.fn().mockResolvedValue(undefined),
    ensurePackageIsInstalled: vi.fn().mockResolvedValue(undefined),
    getPackageDotJson: vi.fn().mockResolvedValue({
      dependencies: { nuxt: "latest" },
    }),
    getOrAskForProjectData: vi.fn(),
  }),
);

describe("runNuxtWizard", () => {
  it("treats a nuxt: latest specifier as an unsupported version instead of crashing", async () => {
    const warn = vi.spyOn(clack.log, "warn").mockImplementation(() => {});
    // "No, I'll upgrade first"
    vi.spyOn(clack, "select").mockResolvedValue(false);
    vi.spyOn(clack, "outro").mockImplementation(() => {});

    await expect(
      runNuxtWizard({ telemetryEnabled: false, ignoreGitChanges: true }),
    ).rejects.toBeInstanceOf(WizardExitError);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Nuxt version <3.7.0"),
    );
    expect(getOrAskForProjectData).not.toHaveBeenCalled();
  });
});
