/**
 * Create the XCTest file that renders SwiftUI previews as snapshots, and add
 * it to the hosted test target.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type { XcodeProject } from "../xcode-manager.js";

const SNAPSHOT_TEST_IMPORT = "import SnapshottingTests";

type EnsureSnapshotTestFileResult =
  | { changed: false; included: false }
  | {
      changed: boolean;
      className: string;
      filePath: string;
      included: true;
    };

export function ensureSnapshotTestFile({
  xcodeProject,
  hostedTestTargetName,
}: {
  xcodeProject: XcodeProject;
  hostedTestTargetName: string;
}): EnsureSnapshotTestFileResult {
  const existingSnapshotTestFile = findExistingSnapshotTestFile(
    xcodeProject,
    hostedTestTargetName,
  );
  if (existingSnapshotTestFile) {
    return {
      changed: false,
      className: existingSnapshotTestFile.className,
      filePath: existingSnapshotTestFile.filePath,
      included: true,
    };
  }

  const className = snapshotTestClassName(hostedTestTargetName);
  const filePath = path.join(
    getSnapshotTestDirectory(xcodeProject, hostedTestTargetName),
    `${className}.swift`,
  );

  mkdirSync(path.dirname(filePath), { recursive: true });
  const fileCreated = !existsSync(filePath);
  if (fileCreated) {
    writeFileSync(filePath, snapshotTestTemplate(className), "utf8");
  }

  const membership = xcodeProject.addSwiftSourceFileToTarget({
    targetName: hostedTestTargetName,
    filePath,
  });

  if (!membership.included) {
    if (fileCreated) {
      unlinkSync(filePath);
    }

    return { changed: false, included: false };
  }

  return {
    changed: fileCreated || membership.changed,
    className,
    filePath,
    included: true,
  };
}

export function snapshotTestClassName(hostedTestTargetName: string): string {
  return `${swiftSafeTypeName(hostedTestTargetName)}SnapshotTest`;
}

export function snapshotTestTemplate(className: string): string {
  return `${SNAPSHOT_TEST_IMPORT}

final class ${className}: SnapshotTest {
  override class func snapshotPreviews() -> [String]? { nil }
  override class func excludedSnapshotPreviews() -> [String]? { nil }
  override class func snapshotPreviewModules() -> [String]? { nil }
  override class func excludedSnapshotPreviewModules() -> [String]? { nil }
}
`;
}

export function swiftSafeTypeName(value: string): string {
  const words = value.split(/[^A-Za-z0-9]+/).filter((word) => word.length > 0);
  const typeName = words
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join("");

  if (!typeName) {
    return "Snapshots";
  }

  return /^[0-9]/.test(typeName) ? `_${typeName}` : typeName;
}

function findExistingSnapshotTestFile(
  xcodeProject: XcodeProject,
  hostedTestTargetName: string,
): { className: string; filePath: string } | undefined {
  const sourceFiles =
    xcodeProject.getSourceFilesForTarget(hostedTestTargetName) ?? [];
  for (const filePath of sourceFiles) {
    if (!filePath.endsWith(".swift") || !existsSync(filePath)) {
      continue;
    }

    const contents = readFileSync(filePath, "utf8");
    const className = getSnapshotTestClassName(contents);
    if (contents.includes(SNAPSHOT_TEST_IMPORT) && className) {
      return { className, filePath };
    }
  }

  return undefined;
}

function getSnapshotTestClassName(contents: string): string | undefined {
  return contents.match(
    /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*SnapshotTest\b/,
  )?.[1];
}

function getSnapshotTestDirectory(
  xcodeProject: XcodeProject,
  hostedTestTargetName: string,
): string {
  const synchronizedRootGroupPath =
    xcodeProject.getSynchronizedRootGroupPathsForTarget(
      hostedTestTargetName,
    )[0];
  if (synchronizedRootGroupPath) {
    return synchronizedRootGroupPath;
  }

  const existingSwiftFile = xcodeProject
    .getSourceFilesForTarget(hostedTestTargetName)
    ?.find((filePath) => filePath.endsWith(".swift"));
  if (existingSwiftFile) {
    return path.dirname(existingSwiftFile);
  }

  return path.join(xcodeProject.baseDir, hostedTestTargetName);
}
