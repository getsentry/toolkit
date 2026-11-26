import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAndroidWizard } from "../../../../src/lib/wizard/android/android-wizard.js";
import { reportCliError } from "../../../../src/lib/error-reporting.js";
import { WizardExitError } from "../../../../src/lib/errors.js";
import { execute } from "../../../../src/lib/wizard/utils/bash.js";
import type { WizardOptions } from "../../../../src/lib/wizard/utils/types.js";

vi.mock("../../../../src/lib/error-reporting.js", () => ({
  reportCliError: vi.fn(),
}));
vi.mock("../../../../src/lib/wizard/utils/bash.js", () => ({
  execute: vi.fn(),
}));
vi.mock("../../../../src/lib/wizard/utils/release-registry.js", () => ({
  fetchSdkVersion: vi.fn().mockResolvedValue("5.0.0"),
}));
vi.mock("../../../../src/lib/wizard/utils/clack/index.js", async () => ({
  ...(await vi.importActual<object>(
    "../../../../src/lib/wizard/utils/clack/index.js",
  )),
  confirmContinueIfNoOrDirtyGitRepo: vi.fn(),
  addSentryCliConfig: vi.fn(),
  getOrAskForProjectData: vi.fn().mockResolvedValue({
    spotlight: false,
    selfHosted: false,
    sentryUrl: "https://sentry.io/",
    authToken: "sntrys_token",
    selectedProject: {
      id: "1",
      slug: "my-app",
      organization: { id: "1", slug: "my-org", name: "My Org" },
      keys: [{ dsn: { public: "https://key@o1.ingest.sentry.io/1" } }],
    },
  }),
}));
vi.mock("@clack/prompts", async () => ({
  ...(await vi.importActual<object>("@clack/prompts")),
  confirm: vi.fn().mockResolvedValue(false),
}));

const OPTIONS: WizardOptions = { telemetryEnabled: false };

const MAIN_ACTIVITY_MANIFEST = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application>
    <activity android:name=".MainActivity">
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
      </intent-filter>
    </activity>
  </application>
</manifest>
`;

describe("runAndroidWizard", () => {
  const originalCwd = process.cwd();
  let projectDir: string;

  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.mocked(execute).mockResolvedValue("");
    projectDir = mkdtempSync(path.join(tmpdir(), "android-wizard-test-"));
    process.chdir(projectDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(projectDir, { recursive: true });
    vi.mocked(reportCliError).mockClear();
    vi.restoreAllMocks();
  });

  function writeApp(manifest: string): void {
    mkdirSync(path.join(projectDir, "app", "src", "main"), {
      recursive: true,
    });
    writeFileSync(
      path.join(projectDir, "app", "build.gradle"),
      `plugins {\n    id 'com.android.application'\n}\n\nandroid {\n    namespace 'com.example'\n}\n`,
    );
    writeFileSync(
      path.join(projectDir, "app", "src", "main", "AndroidManifest.xml"),
      manifest,
    );
  }

  async function expectNonZeroExit(message: string): Promise<void> {
    const error = await runAndroidWizard(OPTIONS).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(WizardExitError);
    expect((error as WizardExitError).exitCode).not.toBe(0);
    expect(reportCliError).not.toHaveBeenCalled();
    const output = vi
      .mocked(process.stdout.write)
      .mock.calls.map(([chunk]) => String(chunk))
      .join("");
    expect(output).toContain(message);
  }

  it("exits non-zero without a Gradle project", async () => {
    await expectNonZeroExit("No Gradle project found.");
  });

  it("exits non-zero when the Gradle sync fails", async () => {
    writeApp(MAIN_ACTIVITY_MANIFEST);
    vi.mocked(execute).mockRejectedValue(new Error("build failed"));

    await expectNonZeroExit("The Gradle sync failed");
  });

  it("exits non-zero without a main activity", async () => {
    writeApp(
      `<manifest><application><activity android:name=".Other" /></application></manifest>`,
    );

    await expectNonZeroExit(
      "Could not find the Activity with intent action MAIN",
    );
  });
});
