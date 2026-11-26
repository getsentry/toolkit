// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as fs from "node:fs";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  abort: vi.fn(),
  askForItemSelection: vi.fn(),
  printSnapshotsUploadSetup: vi.fn(),
  confirm: vi.fn(),
  confirmContinueIfNoOrDirtyGitRepo: vi.fn(),
  configureSnapshotPreviewsXcodeProject: vi.fn(),
  ensureSnapshotTestFile: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  lookupXcodeProject: vi.fn(),
  outro: vi.fn(),
  printWelcome: vi.fn(),
  resolveSnapshotVerificationSchemeName: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  withTelemetry: vi.fn(
    async (_options: { integration: string }, callback: () => Promise<void>) =>
      await callback(),
  ),
  write: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  confirm: mocks.confirm,
  log: {
    error: mocks.error,
    info: mocks.info,
    success: mocks.success,
    warn: mocks.warn,
  },
  outro: mocks.outro,
}));

vi.mock("../../../../../src/lib/wizard/telemetry.js", () => ({
  withTelemetry: mocks.withTelemetry,
}));

vi.mock("../../../../../src/lib/wizard/utils/clack/index.js", () => ({
  abort: mocks.abort,
  abortIfCancelled: async <T>(value: T | Promise<T>) => await value,
  askForItemSelection: mocks.askForItemSelection,
  confirmContinueIfNoOrDirtyGitRepo: mocks.confirmContinueIfNoOrDirtyGitRepo,
  printWelcome: mocks.printWelcome,
}));

vi.mock("../../../../../src/lib/wizard/apple/lookup-xcode-project.js", () => ({
  lookupXcodeProject: mocks.lookupXcodeProject,
  selectXcodeTarget: async (
    xcodeProject: { getAllTargets: () => string[] },
    options: {
      targetNames?: string[];
      promptMessage?: string;
    } = {},
  ): Promise<string> => {
    const targetNames = options.targetNames ?? xcodeProject.getAllTargets();
    if (targetNames.length === 1) {
      return targetNames[0] ?? "";
    }

    const askForItemSelection = mocks.askForItemSelection as (
      items: string[],
      message: string,
    ) => Promise<{ value: string }>;
    const selection = await askForItemSelection(
      targetNames,
      options.promptMessage ?? "Which target do you want to add Sentry to?",
    );
    return selection.value;
  },
}));

vi.mock(
  "../../../../../src/lib/wizard/apple/snapshots/snapshot-test-file.js",
  () => ({
    ensureSnapshotTestFile: mocks.ensureSnapshotTestFile,
    snapshotTestClassName: (hostedTestTargetName: string): string =>
      `${hostedTestTargetName}SnapshotTest`,
    snapshotTestTemplate: (
      className: string,
    ): string => `import SnapshottingTests

final class ${className}: SnapshotTest {
  override class func snapshotPreviews() -> [String]? { nil }
  override class func excludedSnapshotPreviews() -> [String]? { nil }
  override class func snapshotPreviewModules() -> [String]? { nil }
  override class func excludedSnapshotPreviewModules() -> [String]? { nil }
}
`,
  }),
);

vi.mock(
  "../../../../../src/lib/wizard/apple/snapshots/configure-snapshotpreviews-xcode-project.js",
  () => ({
    configureSnapshotPreviewsXcodeProject:
      mocks.configureSnapshotPreviewsXcodeProject,
  }),
);

vi.mock(
  "../../../../../src/lib/wizard/apple/snapshots/snapshots-cli-preflight.js",
  () => ({
    printSnapshotsUploadSetup: mocks.printSnapshotsUploadSetup,
  }),
);

vi.mock(
  "../../../../../src/lib/wizard/apple/snapshots/snapshot-verification-scheme.js",
  () => ({
    resolveSnapshotVerificationSchemeName:
      mocks.resolveSnapshotVerificationSchemeName,
  }),
);

import { runAppleSnapshotsWizard } from "../../../../../src/lib/wizard/apple/snapshots/apple-snapshots-wizard.js";

describe("runAppleSnapshotsWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureSnapshotTestFile.mockReturnValue({
      changed: true,
      className: "AppTestsSnapshotTest",
      filePath: "/tmp/AppTestsSnapshotTest.swift",
      included: true,
    });
    mocks.configureSnapshotPreviewsXcodeProject.mockReturnValue({
      changed: true,
      failedSnapshotPreferencesTargetNames: [],
      linked: true,
    });
    mocks.resolveSnapshotVerificationSchemeName.mockReturnValue("AppScheme");
    mocks.askForItemSelection.mockResolvedValue({ value: "App" });
    mocks.confirm.mockResolvedValue(false);
    mocks.abort.mockRejectedValue(new Error("aborted"));
  });

  it("links SnapshotPreferences only to the selected app target", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "snapshots-wizard-"));
    const selectedPreviewFile = path.join(tempDir, "SelectedView.swift");
    const otherPreviewFile = path.join(tempDir, "OtherView.swift");
    fs.writeFileSync(
      selectedPreviewFile,
      "#Preview { SelectedView() }",
      "utf8",
    );
    fs.writeFileSync(otherPreviewFile, "#Preview { OtherView() }", "utf8");
    mocks.askForItemSelection.mockResolvedValue({ value: "App" });
    const xcodeProject = {
      getBundleIdentifierForTarget: vi.fn(() => "com.getsentry.App"),
      getSourceFilesForTarget: vi.fn((targetName: string) =>
        targetName === "App" ? [selectedPreviewFile] : [otherPreviewFile],
      ),
      getAllTargets: vi.fn(() => ["App", "OtherApp"]),
      getHostedUnitTestTargetNames: vi.fn(() => ["AppTests"]),
      getHostedUnitTestTargetNamesForApplicationTarget: vi.fn(() => [
        "AppTests",
      ]),
      getUnitTestTargetNames: vi.fn(() => ["AppTests"]),
      write: mocks.write,
      xcodeprojPath: path.join(tempDir, "App.xcodeproj"),
    };
    mocks.lookupXcodeProject.mockResolvedValue(xcodeProject);

    await runAppleSnapshotsWizard({
      telemetryEnabled: true,
      projectDir: tempDir,
      ignoreGitChanges: true,
      nonInteractive: false,
    });

    expect(mocks.askForItemSelection).toHaveBeenCalledWith(
      ["App", "OtherApp"],
      "Which app target should SnapshotPreviews use?",
    );
    expect(mocks.configureSnapshotPreviewsXcodeProject).toHaveBeenCalledWith({
      xcodeProject,
      hostedTestTargetName: "AppTests",
      previewTargetNames: ["App"],
    });
  });

  it("prompts only among unit-test targets hosted by the selected app target", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "snapshots-wizard-"));
    const previewFile = path.join(tempDir, "ContentView.swift");
    fs.writeFileSync(previewFile, "#Preview { ContentView() }", "utf8");
    mocks.askForItemSelection.mockResolvedValue({
      value: "AppSnapshotTests",
    });
    const xcodeProject = {
      getBundleIdentifierForTarget: vi.fn(() => "com.getsentry.App"),
      getSourceFilesForTarget: vi.fn(() => [previewFile]),
      getAllTargets: vi.fn(() => ["App"]),
      getHostedUnitTestTargetNames: vi.fn(() => [
        "AppTests",
        "AppSnapshotTests",
      ]),
      getHostedUnitTestTargetNamesForApplicationTarget: vi.fn(() => [
        "AppTests",
        "AppSnapshotTests",
      ]),
      write: mocks.write,
      xcodeprojPath: path.join(tempDir, "App.xcodeproj"),
    };
    mocks.lookupXcodeProject.mockResolvedValue(xcodeProject);

    await runAppleSnapshotsWizard({
      telemetryEnabled: true,
      projectDir: tempDir,
      ignoreGitChanges: true,
      nonInteractive: false,
    });

    expect(
      xcodeProject.getHostedUnitTestTargetNamesForApplicationTarget,
    ).toHaveBeenCalledWith("App");
    expect(mocks.askForItemSelection).toHaveBeenCalledWith(
      ["AppTests", "AppSnapshotTests"],
      "Which test target should render SnapshotPreviews?",
    );
    expect(mocks.configureSnapshotPreviewsXcodeProject).toHaveBeenCalledWith({
      xcodeProject,
      hostedTestTargetName: "AppSnapshotTests",
      previewTargetNames: ["App"],
    });
  });

  it("links SnapshotPreferences to the selected app target without scanning for Swift previews", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "snapshots-wizard-"));
    const selectedFile = path.join(tempDir, "SelectedView.swift");
    const otherPreviewFile = path.join(tempDir, "OtherView.swift");
    fs.writeFileSync(selectedFile, "struct SelectedView {}", "utf8");
    fs.writeFileSync(otherPreviewFile, "#Preview { OtherView() }", "utf8");
    mocks.askForItemSelection.mockResolvedValue({ value: "App" });
    const xcodeProject = {
      getBundleIdentifierForTarget: vi.fn(() => "com.getsentry.App"),
      getSourceFilesForTarget: vi.fn((targetName: string) =>
        targetName === "App" ? [selectedFile] : [otherPreviewFile],
      ),
      getAllTargets: vi.fn(() => ["App", "OtherApp"]),
      getHostedUnitTestTargetNames: vi.fn(() => ["AppTests"]),
      getHostedUnitTestTargetNamesForApplicationTarget: vi.fn(() => [
        "AppTests",
      ]),
      getUnitTestTargetNames: vi.fn(() => ["AppTests"]),
      write: mocks.write,
      xcodeprojPath: path.join(tempDir, "App.xcodeproj"),
    };
    mocks.lookupXcodeProject.mockResolvedValue(xcodeProject);

    await runAppleSnapshotsWizard({
      telemetryEnabled: true,
      projectDir: tempDir,
      ignoreGitChanges: true,
      nonInteractive: false,
    });

    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(xcodeProject.getSourceFilesForTarget).not.toHaveBeenCalled();
    expect(mocks.configureSnapshotPreviewsXcodeProject).toHaveBeenCalledWith({
      xcodeProject,
      hostedTestTargetName: "AppTests",
      previewTargetNames: ["App"],
    });
  });

  it("warns when optional SnapshotPreferences linking fails", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "snapshots-wizard-"));
    const previewFile = path.join(tempDir, "ContentView.swift");
    fs.writeFileSync(previewFile, "#Preview { ContentView() }", "utf8");
    mocks.configureSnapshotPreviewsXcodeProject.mockReturnValue({
      changed: true,
      failedSnapshotPreferencesTargetNames: ["App"],
      linked: true,
    });
    const xcodeProject = {
      getBundleIdentifierForTarget: vi.fn(() => "com.getsentry.App"),
      getSourceFilesForTarget: vi.fn(() => [previewFile]),
      getAllTargets: vi.fn(() => ["App"]),
      getHostedUnitTestTargetNames: vi.fn(() => ["AppTests"]),
      getHostedUnitTestTargetNamesForApplicationTarget: vi.fn(() => [
        "AppTests",
      ]),
      getUnitTestTargetNames: vi.fn(() => ["AppTests"]),
      write: mocks.write,
      xcodeprojPath: path.join(tempDir, "App.xcodeproj"),
    };
    mocks.lookupXcodeProject.mockResolvedValue(xcodeProject);

    await runAppleSnapshotsWizard({
      telemetryEnabled: true,
      projectDir: tempDir,
      ignoreGitChanges: true,
      nonInteractive: false,
    });

    expect(mocks.warn).toHaveBeenCalledWith(
      expect.stringContaining("SnapshotPreferences could not be linked to App"),
    );
    expect(mocks.printSnapshotsUploadSetup).toHaveBeenCalledTimes(1);
  });

  it("links SnapshotPreferences in non-interactive mode without scanning for Swift previews", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "snapshots-wizard-"));
    const selectedFile = path.join(tempDir, "SelectedView.swift");
    fs.writeFileSync(selectedFile, "struct SelectedView {}", "utf8");
    const xcodeProject = {
      getBundleIdentifierForTarget: vi.fn(() => "com.getsentry.App"),
      getSourceFilesForTarget: vi.fn(() => [selectedFile]),
      getAllTargets: vi.fn(() => ["App"]),
      getHostedUnitTestTargetNames: vi.fn(() => ["AppTests"]),
      getHostedUnitTestTargetNamesForApplicationTarget: vi.fn(() => [
        "AppTests",
      ]),
      write: mocks.write,
      xcodeprojPath: path.join(tempDir, "App.xcodeproj"),
    };
    mocks.lookupXcodeProject.mockResolvedValue(xcodeProject);

    await runAppleSnapshotsWizard({
      telemetryEnabled: true,
      projectDir: tempDir,
      ignoreGitChanges: true,
      nonInteractive: true,
    });

    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(xcodeProject.getSourceFilesForTarget).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalledWith(
      expect.stringContaining("Continuing without Swift previews"),
    );
    expect(mocks.configureSnapshotPreviewsXcodeProject).toHaveBeenCalledWith({
      xcodeProject,
      hostedTestTargetName: "AppTests",
      previewTargetNames: ["App"],
    });
  });

  it("uses explicit app and hosted XCTest targets without prompting", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "snapshots-wizard-"));
    const previewFile = path.join(tempDir, "ContentView.swift");
    fs.writeFileSync(previewFile, "#Preview { ContentView() }", "utf8");
    const xcodeProject = {
      getBundleIdentifierForTarget: vi.fn(() => "com.getsentry.App"),
      getSourceFilesForTarget: vi.fn(() => [previewFile]),
      getAllTargets: vi.fn(() => ["App", "OtherApp"]),
      getHostedUnitTestTargetNames: vi.fn(() => ["AppTests"]),
      getHostedUnitTestTargetNamesForApplicationTarget: vi.fn(() => []),
      write: mocks.write,
      xcodeprojPath: path.join(tempDir, "App.xcodeproj"),
    };
    mocks.lookupXcodeProject.mockResolvedValue(xcodeProject);

    await runAppleSnapshotsWizard({
      appTarget: "App",
      hostedTestTarget: "AppTests",
      telemetryEnabled: true,
      projectDir: tempDir,
      ignoreGitChanges: true,
      nonInteractive: true,
    });

    expect(mocks.askForItemSelection).not.toHaveBeenCalled();
    expect(mocks.confirmContinueIfNoOrDirtyGitRepo).toHaveBeenCalledWith({
      ignoreGitChanges: true,
      cwd: tempDir,
      nonInteractive: true,
    });
    expect(mocks.lookupXcodeProject).toHaveBeenCalledWith({
      projectDir: tempDir,
      nonInteractive: true,
    });
    expect(mocks.printSnapshotsUploadSetup).toHaveBeenCalledWith(
      expect.objectContaining({ projectDir: tempDir }),
    );
    expect(
      xcodeProject.getHostedUnitTestTargetNamesForApplicationTarget,
    ).not.toHaveBeenCalled();
    expect(mocks.configureSnapshotPreviewsXcodeProject).toHaveBeenCalledWith({
      xcodeProject,
      hostedTestTargetName: "AppTests",
      previewTargetNames: ["App"],
    });
  });

  it("falls back to prompting among hosted XCTest targets when app-specific matching is inconclusive", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "snapshots-wizard-"));
    const previewFile = path.join(tempDir, "ContentView.swift");
    fs.writeFileSync(previewFile, "#Preview { ContentView() }", "utf8");
    mocks.askForItemSelection.mockResolvedValue({
      value: "AppSnapshotTests",
    });
    const xcodeProject = {
      getBundleIdentifierForTarget: vi.fn(() => "com.getsentry.App"),
      getSourceFilesForTarget: vi.fn(() => [previewFile]),
      getAllTargets: vi.fn(() => ["App"]),
      getHostedUnitTestTargetNames: vi.fn(() => [
        "AppTests",
        "AppSnapshotTests",
      ]),
      getHostedUnitTestTargetNamesForApplicationTarget: vi.fn(() => []),
      write: mocks.write,
      xcodeprojPath: path.join(tempDir, "App.xcodeproj"),
    };
    mocks.lookupXcodeProject.mockResolvedValue(xcodeProject);

    await runAppleSnapshotsWizard({
      telemetryEnabled: true,
      projectDir: tempDir,
      ignoreGitChanges: true,
      nonInteractive: false,
    });

    expect(mocks.warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not automatically match"),
    );
    expect(mocks.askForItemSelection).toHaveBeenCalledWith(
      ["AppTests", "AppSnapshotTests"],
      "Which hosted XCTest target should render SnapshotPreviews?",
    );
    expect(mocks.configureSnapshotPreviewsXcodeProject).toHaveBeenCalledWith({
      xcodeProject,
      hostedTestTargetName: "AppSnapshotTests",
      previewTargetNames: ["App"],
    });
  });

  it("aborts when app target selection is ambiguous in non-interactive mode", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "snapshots-wizard-"));
    const xcodeProject = {
      getAllTargets: vi.fn(() => ["App", "OtherApp"]),
      xcodeprojPath: path.join(tempDir, "App.xcodeproj"),
    };
    mocks.lookupXcodeProject.mockResolvedValue(xcodeProject);

    await expect(
      runAppleSnapshotsWizard({
        telemetryEnabled: true,
        projectDir: tempDir,
        ignoreGitChanges: true,
        nonInteractive: true,
      }),
    ).rejects.toThrow("aborted");

    expect(mocks.askForItemSelection).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith(
      expect.stringContaining("Pass --app-target <target-name>"),
    );
    expect(mocks.configureSnapshotPreviewsXcodeProject).not.toHaveBeenCalled();
    expect(mocks.abort).toHaveBeenCalledWith(
      "Apple Snapshots setup did not complete.",
    );
    expect(mocks.outro).not.toHaveBeenCalledWith(
      "Apple Snapshots setup did not complete.",
    );
  });

  it("aborts with manual instructions instead of prompting when hosted XCTest fallback is ambiguous in non-interactive mode", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "snapshots-wizard-"));
    const xcodeProject = {
      getAllTargets: vi.fn(() => ["App"]),
      getHostedUnitTestTargetNames: vi.fn(() => [
        "AppTests",
        "AppSnapshotTests",
      ]),
      getHostedUnitTestTargetNamesForApplicationTarget: vi.fn(() => []),
      xcodeprojPath: path.join(tempDir, "App.xcodeproj"),
    };
    mocks.lookupXcodeProject.mockResolvedValue(xcodeProject);

    await expect(
      runAppleSnapshotsWizard({
        telemetryEnabled: true,
        projectDir: tempDir,
        ignoreGitChanges: true,
        nonInteractive: true,
      }),
    ).rejects.toThrow("aborted");

    expect(mocks.askForItemSelection).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith(
      expect.stringContaining("Pass --hosted-test-target <target-name>"),
    );
    expect(mocks.error).toHaveBeenCalledWith(
      expect.stringContaining("Manual setup:"),
    );
    expect(mocks.error).toHaveBeenCalledWith(
      expect.stringContaining("import SnapshottingTests"),
    );
    expect(mocks.error).toHaveBeenCalledWith(
      expect.stringContaining("final class AppTestsSnapshotTest"),
    );
    expect(mocks.configureSnapshotPreviewsXcodeProject).not.toHaveBeenCalled();
    expect(mocks.abort).toHaveBeenCalledWith(
      "Apple Snapshots setup did not complete.",
    );
    expect(mocks.outro).not.toHaveBeenCalledWith(
      "Apple Snapshots setup did not complete.",
    );
  });

  it("wires the Apple Snapshots flow without Sentry auth/runtime/CI mutation", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "snapshots-wizard-"));
    const previewFile = path.join(tempDir, "ContentView.swift");
    fs.writeFileSync(previewFile, "#Preview { ContentView() }", "utf8");
    fs.writeFileSync(path.join(tempDir, "Package.swift"), "", "utf8");
    const xcodeProject = {
      getBundleIdentifierForTarget: vi.fn(() => "com.getsentry.App"),
      getSourceFilesForTarget: vi.fn(() => [previewFile]),
      getAllTargets: vi.fn(() => ["App"]),
      getHostedUnitTestTargetNames: vi.fn(() => ["AppTests"]),
      getHostedUnitTestTargetNamesForApplicationTarget: vi.fn(() => [
        "AppTests",
      ]),
      getUnitTestTargetNames: vi.fn(() => ["AppTests"]),
      write: mocks.write,
      xcodeprojPath: path.join(tempDir, "App.xcodeproj"),
    };
    mocks.lookupXcodeProject.mockResolvedValue(xcodeProject);

    await runAppleSnapshotsWizard({
      telemetryEnabled: true,
      projectDir: tempDir,
      ignoreGitChanges: true,
      nonInteractive: false,
    });

    expect(mocks.withTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ integration: "appleSnapshots" }),
      expect.any(Function),
    );
    expect(mocks.printWelcome).toHaveBeenCalledWith({
      wizardName: "Sentry Apple Snapshots Wizard",
    });
    expect(mocks.confirmContinueIfNoOrDirtyGitRepo).toHaveBeenCalledWith({
      ignoreGitChanges: true,
      cwd: tempDir,
      nonInteractive: false,
    });
    expect(mocks.lookupXcodeProject).toHaveBeenCalledWith({
      projectDir: tempDir,
      nonInteractive: false,
    });
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.info).toHaveBeenCalledWith(
      expect.stringContaining("SnapshotPreferences in Swift preview files"),
    );
    expect(mocks.info).toHaveBeenCalledWith(
      expect.stringContaining("This wizard does not edit SwiftPM manifests"),
    );
    expect(mocks.ensureSnapshotTestFile).toHaveBeenCalledWith({
      xcodeProject,
      hostedTestTargetName: "AppTests",
    });
    expect(mocks.configureSnapshotPreviewsXcodeProject).toHaveBeenCalledWith({
      xcodeProject,
      hostedTestTargetName: "AppTests",
      previewTargetNames: ["App"],
    });
    expect(mocks.write).toHaveBeenCalledTimes(1);
    expect(mocks.printSnapshotsUploadSetup).toHaveBeenCalledWith({
      projectDir: tempDir,
      verificationGuidance: {
        appId: "com.getsentry.App",
        hostedTestTargetName: "AppTests",
        projectDir: tempDir,
        projectPath: path.join(tempDir, "App.xcodeproj"),
        schemeName: "AppScheme",
        snapshotTestClassName: "AppTestsSnapshotTest",
      },
    });
    expect(mocks.outro).toHaveBeenCalledWith(
      expect.stringContaining("Apple Snapshots setup complete."),
    );
  });
});
