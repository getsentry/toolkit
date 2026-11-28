import { describe, expect, it, vi } from "vitest";

import { runAngularWizard } from "../../../../src/lib/wizard/angular/angular-wizard.js";
import { WizardExitError } from "../../../../src/lib/errors.js";
import {
  getPackageDotJson,
  installPackage,
} from "../../../../src/lib/wizard/utils/clack/index.js";
import { askShouldReduceDataCollection } from "../../../../src/lib/wizard/utils/data-collection.js";

/** Thrown by the mocked install to stop the flow right after it. */
const { STOP } = vi.hoisted(() => ({ STOP: new Error("stop after install") }));

vi.mock("../../../../src/lib/wizard/telemetry.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withTelemetry: (_options: unknown, fn: () => Promise<unknown>) => fn(),
}));

vi.mock(
  "../../../../src/lib/wizard/utils/data-collection.js",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    askShouldReduceDataCollection: vi.fn().mockRejectedValue(STOP),
  }),
);

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
    printSdkV11MigrationGuideIfOutdated: vi.fn(),
    getPackageDotJson: vi.fn().mockResolvedValue({
      dependencies: { "@angular/core": "^19.0.0" },
    }),
    getOrAskForProjectData: vi.fn().mockResolvedValue({
      spotlight: false,
      selfHosted: false,
      sentryUrl: "https://sentry.io/",
      authToken: "sntrys_token",
      selectedProject: {
        id: "2",
        slug: "my-project",
        organization: { slug: "my-org" },
        keys: [{ dsn: { public: "https://key@o1.ingest.sentry.io/2" } }],
      },
    }),
    installPackage: vi.fn().mockRejectedValue(STOP),
    featureSelectionPrompt: vi.fn().mockRejectedValue(STOP),
  }),
);

describe("runAngularWizard", () => {
  it.each([true, false])(
    "passes forceInstall=%s to installPackage",
    async (forceInstall) => {
      await expect(
        runAngularWizard({
          telemetryEnabled: false,
          ignoreGitChanges: true,
          forceInstall,
        }),
      ).rejects.toBe(STOP);

      expect(installPackage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          packageName: "@sentry/angular@^11",
          forceInstall,
        }),
      );
    },
  );

  it("asks about data collection when the installed SDK version is unknown", async () => {
    vi.mocked(installPackage).mockResolvedValueOnce({});

    await expect(
      runAngularWizard({ telemetryEnabled: false, ignoreGitChanges: true }),
    ).rejects.toBe(STOP);

    expect(askShouldReduceDataCollection).toHaveBeenCalled();
  });

  it("exits cleanly, without a raw semver error, when the installed Angular version does not parse", async () => {
    vi.mocked(getPackageDotJson).mockResolvedValueOnce({
      dependencies: { "@angular/core": "latest" },
    });

    await expect(
      runAngularWizard({ telemetryEnabled: false, ignoreGitChanges: true }),
    ).rejects.toBeInstanceOf(WizardExitError);
    expect(installPackage).not.toHaveBeenCalledWith(
      expect.objectContaining({ packageName: "@sentry/angular@^11" }),
    );
  });
});
