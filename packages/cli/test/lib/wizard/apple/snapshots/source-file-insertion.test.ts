// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { XcodeProject } from "../../../../../src/lib/wizard/apple/xcode-manager.js";
import { copySingleTargetProjectToTemp } from "./hosted-test-target-fixture.js";

vi.mock("@clack/prompts", () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    step: vi.fn(),
  },
}));

function sourceBuildPhaseFiles(xcodeProject: XcodeProject): unknown[] {
  const phase =
    xcodeProject.objects.PBXSourcesBuildPhase?.["D4E604C92D50CEEC00CAB00F"];
  return typeof phase === "object" ? (phase.files ?? []) : [];
}

describe("XcodeProject Swift source-file insertion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adds a Swift source file to a classic PBXSourcesBuildPhase once", () => {
    const xcodeProject = new XcodeProject(
      copySingleTargetProjectToTemp("snapshot-source-file-"),
    );
    const filePath = path.join(
      xcodeProject.baseDir,
      "ProjectTests",
      "SnapshotTest.swift",
    );
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "import SnapshottingTests\n", "utf8");

    const firstResult = xcodeProject.addSwiftSourceFileToTarget({
      targetName: "Project",
      filePath,
    });
    const secondResult = xcodeProject.addSwiftSourceFileToTarget({
      targetName: "Project",
      filePath,
    });

    expect(firstResult).toEqual({ changed: true, included: true });
    expect(secondResult).toEqual({ changed: false, included: true });
    expect(sourceBuildPhaseFiles(xcodeProject)).toHaveLength(1);
    expect(
      Object.values(xcodeProject.objects.PBXFileReference ?? {}).filter(
        (fileReference) =>
          typeof fileReference === "object" &&
          fileReference.path === "ProjectTests/SnapshotTest.swift",
      ),
    ).toHaveLength(1);
  });

  it("uses synchronized root group inclusion when the file is inside a target synchronized folder", () => {
    const xcodeProject = new XcodeProject(
      copySingleTargetProjectToTemp("snapshot-source-file-"),
    );
    const filePath = path.join(
      xcodeProject.baseDir,
      "Sources",
      "SnapshotTest.swift",
    );
    fs.writeFileSync(filePath, "import SnapshottingTests\n", "utf8");

    const result = xcodeProject.addSwiftSourceFileToTarget({
      targetName: "Project",
      filePath,
    });

    expect(result).toEqual({ changed: false, included: true });
    expect(sourceBuildPhaseFiles(xcodeProject)).toEqual([]);
  });
});
