// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as fs from "node:fs";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  ensureSnapshotTestFile,
  swiftSafeTypeName,
} from "../../../../../src/lib/wizard/apple/snapshots/snapshot-test-file.js";
import { XcodeProject } from "../../../../../src/lib/wizard/apple/xcode-manager.js";
import { copySingleTargetProjectToTemp } from "./hosted-test-target-fixture.js";

vi.mock("@clack/prompts", () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    step: vi.fn(),
  },
}));

describe("ensureSnapshotTestFile", () => {
  it("creates a minimal SnapshotTest file and reruns without duplication", () => {
    const xcodeProject = new XcodeProject(
      copySingleTargetProjectToTemp("snapshot-test-file-"),
    );

    const firstResult = ensureSnapshotTestFile({
      xcodeProject,
      hostedTestTargetName: "Project",
    });
    const secondResult = ensureSnapshotTestFile({
      xcodeProject,
      hostedTestTargetName: "Project",
    });

    expect(firstResult.changed).toBe(true);
    expect(firstResult.included).toBe(true);
    expect(secondResult.changed).toBe(false);
    expect(secondResult.included).toBe(true);
    if (!firstResult.included || !secondResult.included) {
      throw new Error("Expected snapshot test files to be included");
    }
    expect(firstResult.className).toBe("ProjectSnapshotTest");
    expect(secondResult.className).toBe("ProjectSnapshotTest");
    expect(firstResult.filePath).toBe(
      path.join(xcodeProject.baseDir, "Sources", "ProjectSnapshotTest.swift"),
    );
    expect(fs.readFileSync(firstResult.filePath, "utf8")).toContain(
      "final class ProjectSnapshotTest: SnapshotTest",
    );
    expect(
      xcodeProject
        .getSourceFilesForTarget("Project")
        ?.filter((filePath) => filePath.endsWith("ProjectSnapshotTest.swift")),
    ).toHaveLength(1);
  });

  it("reuses the actual SnapshotTest class name from an existing file", () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "snapshot-test-file-existing-"),
    );
    const existingFilePath = path.join(tempDir, "CustomSnapshots.swift");
    fs.writeFileSync(
      existingFilePath,
      "import SnapshottingTests\n\nfinal class CustomSnapshots: SnapshotTest {}\n",
      "utf8",
    );
    const addSwiftSourceFileToTarget = vi.fn();
    const xcodeProject = {
      addSwiftSourceFileToTarget,
      getSourceFilesForTarget: vi.fn(() => [existingFilePath]),
      getSynchronizedRootGroupPathsForTarget: vi.fn(() => []),
    } as unknown as XcodeProject;

    const result = ensureSnapshotTestFile({
      xcodeProject,
      hostedTestTargetName: "ProjectTests",
    });

    expect(result).toEqual({
      changed: false,
      className: "CustomSnapshots",
      filePath: existingFilePath,
      included: true,
    });
    expect(addSwiftSourceFileToTarget).not.toHaveBeenCalled();
  });

  it("removes a newly created SnapshotTest file when target membership fails", () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "snapshot-test-file-fail-"),
    );
    const xcodeProject = {
      baseDir: tempDir,
      addSwiftSourceFileToTarget: vi.fn(() => ({
        changed: false,
        included: false,
      })),
      getSourceFilesForTarget: vi.fn(() => []),
      getSynchronizedRootGroupPathsForTarget: vi.fn(() => []),
    } as unknown as XcodeProject;

    const result = ensureSnapshotTestFile({
      xcodeProject,
      hostedTestTargetName: "ProjectTests",
    });

    expect(result).toEqual({ changed: false, included: false });
    expect(
      fs.existsSync(
        path.join(tempDir, "ProjectTests", "ProjectTestsSnapshotTest.swift"),
      ),
    ).toBe(false);
  });

  it("generates Swift-safe type names", () => {
    expect(swiftSafeTypeName("123 My-App Tests")).toBe("_123MyAppTests");
  });
});
