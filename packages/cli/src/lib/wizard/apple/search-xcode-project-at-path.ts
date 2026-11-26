/**
 * List the `.xcodeproj` bundles in a directory, or the ones its
 * `.xcworkspace` references, without CocoaPods' `Pods.xcodeproj`.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { debug } from "../utils/debug.js";
import { findFilesWithExtension } from "../utils/find-files-with-extension.js";

export function searchXcodeProjectAtPath(searchPath: string): string[] {
  debug("Searching for Xcode project at path: " + searchPath);
  const projs = findFilesWithExtension(searchPath, ".xcodeproj");
  if (projs.length > 0) {
    debug("Found Xcode project at paths:");
    for (const proj of projs) {
      debug("  " + proj);
    }
    return projs;
  }

  debug("Searching for Xcode workspace at path: " + searchPath);
  const workspace = findFilesWithExtension(searchPath, ".xcworkspace");
  const [workspaceName] = workspace;
  if (workspaceName === undefined) {
    debug("No Xcode workspace found at path: " + searchPath);
    return [];
  }

  debug("Found Xcode workspace at path: " + workspaceName);
  const xsworkspacedata = path.join(
    searchPath,
    workspaceName,
    "contents.xcworkspacedata",
  );
  if (!existsSync(xsworkspacedata)) {
    debug("No Xcode workspace data found at path: " + xsworkspacedata);
    return [];
  }

  debug("Parsing Xcode workspace data at path: " + xsworkspacedata);
  const groupRegex = /location *= *"group:([^"]+)"/gim;
  const content = readFileSync(xsworkspacedata, "utf8");
  let matches = groupRegex.exec(content);

  while (matches) {
    const group = matches[1] ?? "";
    const groupPath = path.join(searchPath, group);
    if (
      !group.endsWith("Pods.xcodeproj") &&
      group.endsWith(".xcodeproj") &&
      existsSync(groupPath)
    ) {
      projs.push(group);
    }
    matches = groupRegex.exec(content);
  }

  debug("Found Xcode project at paths:");
  for (const proj of projs) {
    debug("  " + proj);
  }
  return projs;
}
