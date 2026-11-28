/**
 * Link the SnapshotPreviews Swift package to the hosted test target and the
 * app targets that use its preview modifiers.
 */

import type {
  SwiftPackageProductSpec,
  SwiftPackageSpec,
  XcodeProject,
} from "../xcode-manager.js";
import {
  SNAPSHOTPREVIEWS_MINIMUM_VERSION,
  SNAPSHOTPREVIEWS_PACKAGE_URL,
  SNAPSHOTPREVIEWS_PREFERENCES_PRODUCT,
  SNAPSHOTPREVIEWS_SNAPSHOT_TESTS_PRODUCT,
} from "./snapshotpreviews-package.js";

export const snapshotPreviewsPackageSpec: SwiftPackageSpec = {
  repositoryURL: SNAPSHOTPREVIEWS_PACKAGE_URL,
  requirement: {
    kind: "upToNextMajorVersion",
    minimumVersion: SNAPSHOTPREVIEWS_MINIMUM_VERSION,
  },
  commentName: "SnapshotPreviews",
};

export const snapshottingTestsProductSpec: SwiftPackageProductSpec = {
  package: snapshotPreviewsPackageSpec,
  productName: SNAPSHOTPREVIEWS_SNAPSHOT_TESTS_PRODUCT,
};

export const snapshotPreferencesProductSpec: SwiftPackageProductSpec = {
  package: snapshotPreviewsPackageSpec,
  productName: SNAPSHOTPREVIEWS_PREFERENCES_PRODUCT,
};

export function configureSnapshotPreviewsXcodeProject({
  xcodeProject,
  hostedTestTargetName,
  previewTargetNames = [],
}: {
  xcodeProject: XcodeProject;
  hostedTestTargetName: string;
  previewTargetNames?: string[] | undefined;
}): {
  changed: boolean;
  failedSnapshotPreferencesTargetNames: string[];
  linked: boolean;
} {
  if (!xcodeProject.getUnitTestTargetNames().includes(hostedTestTargetName)) {
    return {
      changed: false,
      failedSnapshotPreferencesTargetNames: [],
      linked: false,
    };
  }

  const snapshottingTestsResult = xcodeProject.ensureSwiftPackageProductLinked(
    hostedTestTargetName,
    snapshottingTestsProductSpec,
  );
  const snapshotPreferencesResults = previewTargetNames.map((targetName) => ({
    result: xcodeProject.ensureSwiftPackageProductLinked(
      targetName,
      snapshotPreferencesProductSpec,
    ),
    targetName,
  }));
  const linkResults = [
    snapshottingTestsResult,
    ...snapshotPreferencesResults.map(({ result }) => result),
  ];
  const failedSnapshotPreferencesTargetNames = snapshotPreferencesResults
    .filter(({ result }) => !result.linked)
    .map(({ targetName }) => targetName);

  return {
    changed: linkResults.some((result) => result.changed),
    failedSnapshotPreferencesTargetNames,
    linked: snapshottingTestsResult.linked,
  };
}
