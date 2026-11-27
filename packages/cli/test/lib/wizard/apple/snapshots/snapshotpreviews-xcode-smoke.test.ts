// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PBXNativeTarget } from "xcode";

import { configureSnapshotPreviewsXcodeProject } from "../../../../../src/lib/wizard/apple/snapshots/configure-snapshotpreviews-xcode-project.js";
import { ensureSnapshotTestFile } from "../../../../../src/lib/wizard/apple/snapshots/snapshot-test-file.js";
import {
  SNAPSHOTPREVIEWS_PACKAGE_URL,
  SNAPSHOTPREVIEWS_PREFERENCES_PRODUCT,
  SNAPSHOTPREVIEWS_SNAPSHOT_TESTS_PRODUCT,
} from "../../../../../src/lib/wizard/apple/snapshots/snapshotpreviews-package.js";
import { XcodeProject } from "../../../../../src/lib/wizard/apple/xcode-manager.js";
import {
  addHostedUnitTestTarget,
  copySingleTargetProjectToTemp,
} from "./hosted-test-target-fixture.js";

vi.mock("@clack/prompts", () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    step: vi.fn(),
  },
}));

const projectObjectId = "D4E604C52D50CEEC00CAB00F";
const productsGroupId = "D4E604CE2D50CEEC00CAB00F";

const hostedTestTargetIds = {
  targetId: "AAAABBBBCCCCDDDDEEEE0001",
  frameworksBuildPhaseId: "AAAABBBBCCCCDDDDEEEE0002",
  sourcesBuildPhaseId: "AAAABBBBCCCCDDDDEEEE0003",
  debugBuildConfigurationId: "AAAABBBBCCCCDDDDEEEE0004",
  releaseBuildConfigurationId: "AAAABBBBCCCCDDDDEEEE0005",
  buildConfigurationListId: "AAAABBBBCCCCDDDDEEEE0006",
  productReferenceId: "AAAABBBBCCCCDDDDEEEE0007",
};

function getTargetByName(
  xcodeProject: XcodeProject,
  targetName: string,
): PBXNativeTarget {
  const target = Object.values(xcodeProject.objects.PBXNativeTarget ?? {}).find(
    (candidate) => {
      return typeof candidate !== "string" && candidate.name === targetName;
    },
  ) as PBXNativeTarget | undefined;

  if (!target) {
    throw new Error(`Target not found: ${targetName}`);
  }

  return target;
}

function getProductDependencyIds(
  xcodeProject: XcodeProject,
  productName: string,
): string[] {
  return Object.entries(
    xcodeProject.objects.XCSwiftPackageProductDependency ?? {},
  ).reduce((ids, [id, productDependency]) => {
    if (
      id.endsWith("_comment") ||
      typeof productDependency === "string" ||
      productDependency.productName !== productName
    ) {
      return ids;
    }

    return [...ids, id];
  }, new Array<string>());
}

function getProductDependency(
  xcodeProject: XcodeProject,
  productDependencyId: string,
) {
  const productDependency =
    xcodeProject.objects.XCSwiftPackageProductDependency?.[productDependencyId];
  if (!productDependency || typeof productDependency === "string") {
    throw new Error(`Product dependency not found: ${productDependencyId}`);
  }

  return productDependency;
}

function getFrameworkProductRefs(
  xcodeProject: XcodeProject,
  targetName: string,
): string[] {
  return (getTargetByName(xcodeProject, targetName).buildPhases ?? []).reduce(
    (productRefs, buildPhaseReference) => {
      const buildPhase =
        xcodeProject.objects.PBXFrameworksBuildPhase?.[
          buildPhaseReference.value
        ];
      if (!buildPhase || typeof buildPhase === "string") {
        return productRefs;
      }

      return [
        ...productRefs,
        ...(buildPhase.files ?? []).flatMap((file) => {
          const buildFile = xcodeProject.objects.PBXBuildFile?.[file.value];
          return buildFile &&
            typeof buildFile !== "string" &&
            typeof buildFile.productRef === "string"
            ? [buildFile.productRef]
            : [];
        }),
      ];
    },
    new Array<string>(),
  );
}

function getSnapshotPreviewsPackageReferenceIds(
  xcodeProject: XcodeProject,
): string[] {
  return Object.entries(
    xcodeProject.objects.XCRemoteSwiftPackageReference ?? {},
  ).reduce((ids, [id, packageReference]) => {
    if (
      id.endsWith("_comment") ||
      typeof packageReference === "string" ||
      packageReference.repositoryURL !== `"${SNAPSHOTPREVIEWS_PACKAGE_URL}"`
    ) {
      return ids;
    }

    return [...ids, id];
  }, new Array<string>());
}

describe("SnapshotPreviews hosted XCTest Xcode project smoke coverage", () => {
  it("mutates, reparses, and reruns without duplicating package or source membership", () => {
    const pbxprojPath = copySingleTargetProjectToTemp(
      "snapshotpreviews-xcode-smoke-",
    );
    const xcodeProject = new XcodeProject(pbxprojPath);
    addHostedUnitTestTarget(xcodeProject, {
      ids: hostedTestTargetIds,
      includeSourcesBuildPhase: true,
      projectObjectId,
      productsGroupId,
    });

    const snapshotTestResult = ensureSnapshotTestFile({
      xcodeProject,
      hostedTestTargetName: "ProjectTests",
    });
    const packageResult = configureSnapshotPreviewsXcodeProject({
      xcodeProject,
      hostedTestTargetName: "ProjectTests",
      previewTargetNames: ["Project"],
    });
    xcodeProject.write();

    expect(snapshotTestResult.changed).toBe(true);
    expect(snapshotTestResult.included).toBe(true);
    if (!snapshotTestResult.included) {
      throw new Error("Expected snapshot test file to be included");
    }
    expect(snapshotTestResult.filePath).toBe(
      path.join(
        xcodeProject.baseDir,
        "ProjectTests",
        "ProjectTestsSnapshotTest.swift",
      ),
    );
    expect(packageResult).toEqual({
      changed: true,
      failedSnapshotPreferencesTargetNames: [],
      linked: true,
    });

    const firstSerializedProject = fs.readFileSync(pbxprojPath, "utf8");
    const reparsedProject = new XcodeProject(pbxprojPath);

    expect(reparsedProject.getUnitTestTargetNames()).toContain("ProjectTests");
    expect(
      getSnapshotPreviewsPackageReferenceIds(reparsedProject),
    ).toHaveLength(1);

    const snapshottingTestsProductDependencyIds = getProductDependencyIds(
      reparsedProject,
      SNAPSHOTPREVIEWS_SNAPSHOT_TESTS_PRODUCT,
    );
    const snapshotPreferencesProductDependencyIds = getProductDependencyIds(
      reparsedProject,
      SNAPSHOTPREVIEWS_PREFERENCES_PRODUCT,
    );
    expect(snapshottingTestsProductDependencyIds).toHaveLength(1);
    expect(snapshotPreferencesProductDependencyIds).toHaveLength(1);
    expect(
      getProductDependency(
        reparsedProject,
        snapshottingTestsProductDependencyIds[0] ?? "",
      ).package,
    ).toBe(getSnapshotPreviewsPackageReferenceIds(reparsedProject)[0]);
    expect(
      getProductDependency(
        reparsedProject,
        snapshotPreferencesProductDependencyIds[0] ?? "",
      ).package,
    ).toBe(getSnapshotPreviewsPackageReferenceIds(reparsedProject)[0]);
    expect(getFrameworkProductRefs(reparsedProject, "ProjectTests")).toEqual([
      snapshottingTestsProductDependencyIds[0],
    ]);
    expect(getFrameworkProductRefs(reparsedProject, "Project")).toEqual([
      snapshotPreferencesProductDependencyIds[0],
    ]);

    expect(
      getTargetByName(reparsedProject, "ProjectTests")
        .packageProductDependencies,
    ).toEqual([
      {
        value: snapshottingTestsProductDependencyIds[0],
        comment: SNAPSHOTPREVIEWS_SNAPSHOT_TESTS_PRODUCT,
      },
    ]);
    expect(
      getTargetByName(reparsedProject, "Project").packageProductDependencies,
    ).toEqual([
      {
        value: snapshotPreferencesProductDependencyIds[0],
        comment: SNAPSHOTPREVIEWS_PREFERENCES_PRODUCT,
      },
    ]);
    expect(
      reparsedProject
        .getSourceFilesForTarget("ProjectTests")
        ?.filter((sourceFilePath) =>
          sourceFilePath.endsWith(
            "ProjectTests/ProjectTestsSnapshotTest.swift",
          ),
        ),
    ).toHaveLength(1);

    const secondSnapshotTestResult = ensureSnapshotTestFile({
      xcodeProject: reparsedProject,
      hostedTestTargetName: "ProjectTests",
    });
    const secondPackageResult = configureSnapshotPreviewsXcodeProject({
      xcodeProject: reparsedProject,
      hostedTestTargetName: "ProjectTests",
      previewTargetNames: ["Project"],
    });
    reparsedProject.write();

    expect(secondSnapshotTestResult.changed).toBe(false);
    expect(secondPackageResult).toEqual({
      changed: false,
      failedSnapshotPreferencesTargetNames: [],
      linked: true,
    });
    expect(fs.readFileSync(pbxprojPath, "utf8")).toBe(firstSerializedProject);
  }, 15_000);
});
