import { beforeEach, describe, expect, it, vi } from "vitest";

const { installPackageMock } = vi.hoisted(() => ({
  installPackageMock: vi.fn(),
}));

vi.mock("../../../../src/lib/wizard/telemetry.js", () => ({
  Sentry: { setTag: vi.fn() },
  withTelemetry: (_options: unknown, callback: () => unknown) => callback(),
  traceStep: (_name: string, callback: () => unknown) => callback(),
}));

vi.mock("../../../../src/lib/wizard/utils/clack/index.js", () => ({
  printWelcome: vi.fn(),
  getPackageDotJson: vi.fn(() =>
    Promise.resolve({ devDependencies: { "@react-router/dev": "^7.0.0" } }),
  ),
  isUsingTypeScript: vi.fn(() => true),
  confirmContinueIfNoOrDirtyGitRepo: vi.fn(() => Promise.resolve()),
  getOrAskForProjectData: vi.fn(() =>
    Promise.resolve({
      spotlight: false,
      selfHosted: false,
      sentryUrl: "https://sentry.io/",
      authToken: "token",
      selectedProject: {
        id: "1",
        slug: "project",
        organization: { id: "1", slug: "org", name: "Org" },
        keys: [{ dsn: { public: "https://key@sentry.io/1" } }],
      },
    }),
  ),
  printSdkV11MigrationGuideIfOutdated: vi.fn(),
  installPackage: installPackageMock,
}));

vi.mock("../../../../src/lib/wizard/utils/node-version.js", () => ({
  warnIfNodeVersionUnsupportedBySdkV11: vi.fn(),
}));

import { runReactRouterWizard } from "../../../../src/lib/wizard/react-router/react-router-wizard.js";
import { printWelcome } from "../../../../src/lib/wizard/utils/clack/index.js";

describe("runReactRouterWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Stop the wizard right after the SDK install; only its options matter.
    installPackageMock.mockRejectedValue(new Error("stop after install"));
  });

  it.each([true, false])(
    "passes forceInstall=%s to the SDK install",
    async (forceInstall) => {
      await expect(
        runReactRouterWizard({
          telemetryEnabled: false,
          forceInstall,
        }),
      ).rejects.toThrow("stop after install");

      expect(installPackageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          packageNameDisplayLabel: "@sentry/react-router",
          forceInstall,
        }),
      );
    },
  );

  it.each([true, false])(
    "shows the telemetry disclosure when telemetryEnabled=%s",
    async (telemetryEnabled) => {
      await expect(
        runReactRouterWizard({ telemetryEnabled, forceInstall: false }),
      ).rejects.toThrow("stop after install");

      expect(printWelcome).toHaveBeenCalledWith(
        expect.objectContaining({ telemetryEnabled }),
      );
    },
  );
});
