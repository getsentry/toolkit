import { beforeEach, describe, expect, it, vi } from "vitest";

import { runCloudflareWizard } from "../../../../src/lib/wizard/cloudflare/cloudflare-wizard.js";
import { updateWranglerConfig } from "../../../../src/lib/wizard/cloudflare/wrangler/update-wrangler-config.js";
import { askShouldReduceDataCollection } from "../../../../src/lib/wizard/utils/data-collection.js";
import { getPackageVersion } from "../../../../src/lib/wizard/utils/package-json.js";
import type { WizardOptions } from "../../../../src/lib/wizard/utils/types.js";

vi.mock("@clack/prompts", () => ({
  log: { info: vi.fn(), warn: vi.fn(), success: vi.fn() },
  outro: vi.fn(),
}));
vi.mock("../../../../src/lib/wizard/telemetry.js", () => ({
  withTelemetry: (_options: unknown, callback: () => unknown) => callback(),
  traceStep: (_step: string, callback: () => unknown) => callback(),
}));
vi.mock("../../../../src/lib/wizard/utils/clack/index.js", () => ({
  confirmContinueIfNoOrDirtyGitRepo: vi.fn(),
  ensurePackageIsInstalled: vi.fn(),
  featureSelectionPrompt: vi
    .fn()
    .mockResolvedValue({ performance: false, logs: false }),
  getOrAskForProjectData: vi.fn().mockResolvedValue({
    spotlight: false,
    selectedProject: {
      slug: "my-project",
      organization: { slug: "my-org" },
      keys: [{ dsn: { public: "https://key@example.ingest.sentry.io/1" } }],
    },
  }),
  getPackageDotJson: vi.fn().mockResolvedValue({}),
  installPackage: vi.fn(),
  printSdkV11MigrationGuideIfOutdated: vi.fn(),
  printWelcome: vi.fn(),
  runPrettierIfInstalled: vi.fn(),
}));
vi.mock("../../../../src/lib/wizard/utils/clack/mcp-config.js", () => ({
  offerProjectScopedMcpConfig: vi.fn(),
}));
vi.mock("../../../../src/lib/wizard/utils/data-collection.js", async () => ({
  ...(await vi.importActual(
    "../../../../src/lib/wizard/utils/data-collection.js",
  )),
  askShouldReduceDataCollection: vi.fn().mockResolvedValue(false),
}));
vi.mock("../../../../src/lib/wizard/utils/node-version.js", () => ({
  warnIfNodeVersionUnsupportedBySdkV11: vi.fn(),
}));
vi.mock("../../../../src/lib/wizard/utils/package-json.js", () => ({
  getPackageVersion: vi.fn(),
  hasPackageInstalled: vi.fn().mockReturnValue(false),
}));
vi.mock("../../../../src/lib/wizard/cloudflare/sdk-setup.js", () => ({
  createSentryInitFile: vi.fn(),
}));
vi.mock(
  "../../../../src/lib/wizard/cloudflare/wrangler/ensure-wrangler-config.js",
  () => ({ ensureWranglerConfig: vi.fn() }),
);
vi.mock(
  "../../../../src/lib/wizard/cloudflare/wrangler/get-entry-point-from-wrangler-config.js",
  () => ({
    defaultEntryPoint: "src/index.ts",
    getEntryPointFromWranglerConfig: vi.fn().mockReturnValue("src/index.ts"),
  }),
);
vi.mock(
  "../../../../src/lib/wizard/cloudflare/wrangler/update-wrangler-config.js",
  () => ({ updateWranglerConfig: vi.fn() }),
);

const options: WizardOptions = {
  telemetryEnabled: false,
  forceInstall: false,
  ignoreGitChanges: true,
};

describe("runCloudflareWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("offers to reduce data collection when the installed SDK version is unknown", async () => {
    // e.g. `workspace:*`: the wizard falls back to the major it installs (v11)
    vi.mocked(getPackageVersion).mockReturnValue(undefined);

    await runCloudflareWizard(options);

    expect(askShouldReduceDataCollection).toHaveBeenCalledTimes(1);
  });

  it("does not offer it when an older SDK stays installed", async () => {
    vi.mocked(getPackageVersion).mockReturnValue("^10.5.0");

    await runCloudflareWizard(options);

    expect(askShouldReduceDataCollection).not.toHaveBeenCalled();
  });

  it("keeps the Worker's existing compatibility_date", async () => {
    await runCloudflareWizard(options);

    expect(updateWranglerConfig).toHaveBeenCalledWith(
      expect.objectContaining({ compatibility_date: expect.any(String) }),
      expect.objectContaining({ keepCompatibilityDate: true }),
    );
  });
});
