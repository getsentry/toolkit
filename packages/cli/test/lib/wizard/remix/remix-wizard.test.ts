import { beforeEach, describe, expect, it, vi } from "vitest";

const { askShouldReduceDataCollectionMock, getPackageDotJsonMock } = vi.hoisted(
  () => ({
    askShouldReduceDataCollectionMock: vi.fn(),
    getPackageDotJsonMock: vi.fn(),
  }),
);

vi.mock("../../../../src/lib/wizard/telemetry.js", () => ({
  Sentry: { setTag: vi.fn() },
  withTelemetry: (_options: unknown, callback: () => unknown) => callback(),
  traceStep: (_name: string, callback: () => unknown) => callback(),
}));

vi.mock("../../../../src/lib/wizard/utils/clack/index.js", () => ({
  printWelcome: vi.fn(),
  getPackageDotJson: getPackageDotJsonMock,
  confirmContinueIfNoOrDirtyGitRepo: vi.fn(() => Promise.resolve()),
  ensurePackageIsInstalled: vi.fn(() => Promise.resolve()),
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
  installPackage: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../../src/lib/wizard/utils/data-collection.js", async () => ({
  ...(await vi.importActual<
    typeof import("../../../../src/lib/wizard/utils/data-collection.js")
  >("../../../../src/lib/wizard/utils/data-collection.js")),
  askShouldReduceDataCollection: askShouldReduceDataCollectionMock,
}));

vi.mock("../../../../src/lib/wizard/utils/node-version.js", () => ({
  warnIfNodeVersionUnsupportedBySdkV11: vi.fn(),
}));

import { runRemixWizard } from "../../../../src/lib/wizard/remix/remix-wizard.js";

describe("runRemixWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Stop the wizard at the data collection prompt; only reaching it matters.
    askShouldReduceDataCollectionMock.mockRejectedValue(
      new Error("stop at data collection"),
    );
  });

  it.each([undefined, "workspace:*"])(
    "offers to reduce data collection when the installed SDK version is %s",
    async (installedVersion) => {
      getPackageDotJsonMock.mockResolvedValue({
        dependencies: {
          "@remix-run/react": "^2.0.0",
          ...(installedVersion && { "@sentry/remix": installedVersion }),
        },
      });

      await expect(runRemixWizard({ telemetryEnabled: false })).rejects.toThrow(
        "stop at data collection",
      );
      expect(askShouldReduceDataCollectionMock).toHaveBeenCalledTimes(1);
    },
  );
});
