/**
 * Find the Xcode scheme to suggest in the snapshot export command: the one
 * shared or user scheme whose test action runs the hosted test target, or
 * else the project's only scheme.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { debug } from "../../utils/debug.js";
import {
  findFilesWithExtension,
  findFilesWithName,
} from "../../utils/files.js";
import {
  getAttributeValues,
  getElementContent,
  getElementTexts,
} from "./xml-scan.js";

type SnapshotVerificationSchemeOptions = {
  hostedTestTargetName: string;
  xcodeprojPath: string;
};

type ExplicitScheme = {
  name: string;
  testTargetNames: string[];
};

export function resolveSnapshotVerificationSchemeName({
  hostedTestTargetName,
  xcodeprojPath,
}: SnapshotVerificationSchemeOptions): string | undefined {
  const explicitSchemes = getExplicitSchemes(xcodeprojPath);
  const matchingExplicitSchemes = explicitSchemes.filter((scheme) =>
    scheme.testTargetNames.includes(hostedTestTargetName),
  );
  const matchingExplicitSchemeNames = uniqueStrings(
    matchingExplicitSchemes.map((scheme) => scheme.name),
  );
  if (matchingExplicitSchemeNames.length === 1) {
    return matchingExplicitSchemeNames[0];
  }

  const managedSchemeNames = getManagedSchemeNames(xcodeprojPath);
  if (managedSchemeNames.length === 1) {
    return managedSchemeNames[0];
  }

  return undefined;
}

function getExplicitSchemes(xcodeprojPath: string): ExplicitScheme[] {
  return getSchemeFilePaths(xcodeprojPath).flatMap((schemePath) => {
    const schemeName = path.basename(schemePath, ".xcscheme");
    const testTargetNames = readSchemeTestTargetNames(schemePath);
    return schemeName ? [{ name: schemeName, testTargetNames }] : [];
  });
}

function getSchemeFilePaths(xcodeprojPath: string): string[] {
  return [
    path.join(xcodeprojPath, "xcshareddata", "xcschemes"),
    path.join(xcodeprojPath, "xcuserdata"),
  ].flatMap((schemeDirectory) =>
    findFilesWithExtension(schemeDirectory, ".xcscheme"),
  );
}

function readSchemeTestTargetNames(schemePath: string): string[] {
  const scheme = readXmlFile(schemePath);
  if (scheme === undefined) {
    return [];
  }

  const testAction = getElementContent(scheme, "TestAction");
  if (testAction === undefined) {
    return [];
  }
  return uniqueStrings(getAttributeValues(testAction, "BlueprintName"));
}

function getManagedSchemeNames(xcodeprojPath: string): string[] {
  return uniqueStrings(
    findFilesWithName(xcodeprojPath, "xcschememanagement.plist").flatMap(
      readManagedSchemeNames,
    ),
  );
}

function readManagedSchemeNames(plistPath: string): string[] {
  const plist = readXmlFile(plistPath);
  if (plist === undefined) {
    return [];
  }

  return getElementTexts(plist, "key").flatMap((key) => {
    const schemeName = parseManagedSchemeName(key);
    return schemeName ? [schemeName] : [];
  });
}

function parseManagedSchemeName(key: string): string | undefined {
  return /^(.+)\.xcscheme(?:_.+)?$/.exec(key)?.[1];
}

function readXmlFile(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    debug("Could not read XML file:", filePath, error);
    return undefined;
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
