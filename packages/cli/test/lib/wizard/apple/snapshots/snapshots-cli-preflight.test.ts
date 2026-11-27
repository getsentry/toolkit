// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as fs from "node:fs";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  log: {
    info: mocks.info,
    success: mocks.success,
    warn: mocks.warn,
  },
}));

import {
  getSnapshotFastlaneGuidance,
  printSnapshotsUploadSetup,
} from "../../../../../src/lib/wizard/apple/snapshots/snapshots-cli-preflight.js";

function getVerificationGuidance(projectDir: string) {
  return {
    appId: "com.getsentry.App",
    hostedTestTargetName: "AppTests",
    projectDir,
    projectPath: path.join(projectDir, "App.xcodeproj"),
    schemeName: "App",
    snapshotTestClassName: "AppTestsSnapshotTest",
  };
}

describe("snapshots CLI preflight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prefers existing Fastlane guidance", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-cli-"));
    const fastlaneDir = path.join(projectDir, "fastlane");
    fs.mkdirSync(fastlaneDir);
    fs.writeFileSync(
      path.join(fastlaneDir, "Fastfile"),
      "platform :ios do\n  lane :upload_sentry_snapshots do |options|\n    sentry_upload_snapshots(path: options[:path])\n  end\nend\n",
    );

    printSnapshotsUploadSetup({
      projectDir,
      verificationGuidance: getVerificationGuidance(projectDir),
    });

    expect(mocks.info).toHaveBeenCalledWith(
      expect.stringContaining("xcodebuild test"),
    );
    expect(mocks.info).toHaveBeenCalledWith(
      expect.stringContaining("-project App.xcodeproj"),
    );
    expect(mocks.info).toHaveBeenCalledWith(
      expect.stringContaining("-scheme App"),
    );
    expect(mocks.info).toHaveBeenCalledWith(
      expect.stringContaining("-only-testing:AppTests/AppTestsSnapshotTest"),
    );
    expect(mocks.info).toHaveBeenCalledWith(
      expect.stringContaining(
        "bundle exec fastlane ios upload_sentry_snapshots",
      ),
    );
  });

  it("prints xcodebuild export and sentry snapshots upload guidance", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-cli-"));

    printSnapshotsUploadSetup({
      projectDir,
      verificationGuidance: getVerificationGuidance(projectDir),
    });

    expect(mocks.info).toHaveBeenCalledWith(
      expect.stringContaining("TEST_RUNNER_SNAPSHOTS_EXPORT_DIR"),
    );
    expect(mocks.info).toHaveBeenCalledWith(
      expect.stringContaining("-only-testing:AppTests/AppTestsSnapshotTest"),
    );
    expect(mocks.info).toHaveBeenCalledWith(
      expect.stringContaining("sentry snapshots upload"),
    );
    expect(mocks.info).toHaveBeenCalledWith(
      expect.stringContaining("--app-id com.getsentry.App"),
    );
    expect(mocks.info).not.toHaveBeenCalledWith(
      expect.stringContaining("sentry-cli"),
    );
  });

  it("uses the provided snapshot test class name in xcodebuild guidance", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-cli-"));

    printSnapshotsUploadSetup({
      projectDir,
      verificationGuidance: {
        ...getVerificationGuidance(projectDir),
        snapshotTestClassName: "CustomSnapshots",
      },
    });

    expect(mocks.info).toHaveBeenCalledWith(
      expect.stringContaining("-only-testing:AppTests/CustomSnapshots"),
    );
    expect(mocks.info).not.toHaveBeenCalledWith(
      expect.stringContaining("-only-testing:AppTests/AppTestsSnapshotTest"),
    );
  });

  it("uses a scheme placeholder when no verification scheme was detected", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-cli-"));

    printSnapshotsUploadSetup({
      projectDir,
      verificationGuidance: {
        ...getVerificationGuidance(projectDir),
        schemeName: undefined,
      },
    });

    expect(mocks.info).toHaveBeenCalledWith(
      expect.stringContaining("-scheme <scheme>"),
    );
    expect(mocks.info).not.toHaveBeenCalledWith(
      expect.stringContaining("-scheme '<scheme>'"),
    );
  });

  it("uses an explicit app id placeholder when the bundle identifier is unavailable", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-cli-"));
    const verificationGuidance = {
      ...getVerificationGuidance(projectDir),
      appId: undefined,
    };

    printSnapshotsUploadSetup({
      projectDir,
      verificationGuidance,
    });

    expect(mocks.info).toHaveBeenCalledWith(
      expect.stringContaining("--app-id YOUR_APP_BUNDLE_ID"),
    );
    expect(mocks.info).not.toHaveBeenCalledWith(
      expect.stringContaining("com.example.MyApp"),
    );
    expect(mocks.info).not.toHaveBeenCalledWith(
      expect.stringContaining("<your-app-bundle-id>"),
    );
  });

  it("detects existing Fastlane snapshots upload support", () => {
    const projectDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "snapshot-fastlane-"),
    );
    const fastlaneDir = path.join(projectDir, "fastlane");
    fs.mkdirSync(fastlaneDir);
    fs.writeFileSync(
      path.join(fastlaneDir, "Fastfile"),
      'lane :upload_sentry_snapshots do\n  sentry_upload_snapshots(path: "snapshot-images")\nend\n',
    );

    expect(getSnapshotFastlaneGuidance(projectDir)).toEqual({
      fastfilePath: path.join(fastlaneDir, "Fastfile"),
      hasUploadLane: true,
      hasSentryUploadAction: true,
    });
  });
});
