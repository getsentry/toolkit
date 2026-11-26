/**
 * Find the Fastfile, its iOS platform block and lanes, and add the Sentry
 * debug-files upload action to the lane the user picks.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { askForItemSelection } from "../utils/clack/index.js";
import { getFastlaneSnippet } from "./templates.js";
import { clack } from "../utils/clack/prompts.js";

export function fastFile(projectPath: string): string | null {
  const fastlanePath = path.join(projectPath, "fastlane", "Fastfile");
  return existsSync(fastlanePath) ? fastlanePath : null;
}

function findIOSPlatform(
  content: string,
): { index: number; length: number } | null {
  const platformRegex = /^ *platform\s+:([^ ]+)[^\n]*\n/gim;
  let match = platformRegex.exec(content);
  if (!match) {
    // No platform found, treat whole file as one platform.
    return { index: 0, length: content.length };
  }

  let index = -1;
  while (match) {
    if (match[1] === "ios") {
      index = match.index + match[0].length;
      break;
    }
    match = platformRegex.exec(content);
  }

  if (index === -1) {
    return null;
  }

  //After finding the platform, we need to find the end of the platform block.
  //This solution has the assumption that the file is well formed,
  //which is not a perfect solution, but it's good enough assumption.
  const platformEndRegex = /^end[^\n]*/gim;
  match = platformEndRegex.exec(content.slice(index));
  if (!match) {
    return null;
  }

  return { index, length: match.index };
}

function findLanes(
  content: string,
): { index: number; length: number; name: string }[] | null {
  const laneRegex = /^ {2}lane\s+:([^ ]+)[^\n]*\n/gim;
  let match = laneRegex.exec(content);
  if (!match) {
    return null;
  }

  const lanes: { index: number; length: number; name: string }[] = [];
  while (match) {
    const laneEnd = /^ {2}end/m.exec(
      content.slice(match.index + match[0].length),
    );
    if (laneEnd === null) {
      return null;
    }
    lanes.push({
      index: match.index + match[0].length,
      length: laneEnd.index,
      name: match[1] ?? "",
    });
    match = laneRegex.exec(content);
  }
  return lanes;
}

function addSentryToLane(
  content: string,
  lane: { index: number; length: number; name: string },
  org: string,
  project: string,
): string {
  const laneContent = content.slice(lane.index, lane.index + lane.length);
  const sentryCLIMatch = /(\n\s+)sentry_debug_files_upload\s*\([^)]+\)/gim.exec(
    laneContent,
  );
  if (sentryCLIMatch) {
    // Sentry already added to lane. Update it.
    // sentryCLIMatch[1] contains the leading newline and whitespace
    return (
      content.slice(0, sentryCLIMatch.index + lane.index) +
      sentryCLIMatch[1] +
      getFastlaneSnippet(org, project).trim() +
      content.slice(
        sentryCLIMatch.index + sentryCLIMatch[0].length + lane.index,
      )
    );
  }

  // Sentry not added to lane. Add it.
  return (
    content.slice(0, lane.index + lane.length) +
    "\n" +
    getFastlaneSnippet(org, project) +
    "\n" +
    content.slice(lane.index + lane.length)
  );
}

export async function addSentryToFastlane(
  projectDir: string,
  org: string,
  project: string,
): Promise<boolean> {
  const fastFilePath = fastFile(projectDir);
  if (!fastFilePath) {
    return false;
  }

  const fileContent = readFileSync(fastFilePath, "utf8");
  const platform = findIOSPlatform(fileContent);
  if (!platform) {
    return false;
  }

  const platformContent = fileContent.slice(
    platform.index,
    platform.index + platform.length,
  );
  const lanes = findLanes(platformContent);
  lanes?.forEach((l) => (l.index += platform.index));

  if (!lanes || lanes.length === 0) {
    clack.log.warn("No suitable lanes in your Fastfile.");
    return false;
  }

  let newFileContent: string | undefined;
  const [onlyLane] = lanes;
  if (lanes.length === 1 && onlyLane) {
    newFileContent = addSentryToLane(fileContent, onlyLane, org, project);
  } else {
    const laneNames = lanes.map((l) => l.name);
    const selectedLane = await askForItemSelection(
      laneNames,
      "Select lane to add Sentry to:",
    );
    const lane = lanes[selectedLane.index];
    if (!lane) {
      return false;
    }
    newFileContent = addSentryToLane(fileContent, lane, org, project);
  }

  writeFileSync(fastFilePath, newFileContent, "utf8");
  return true;
}

/**
 * Exported for testing purposes, but should not be used in other modules.
 */
export let exportForTesting: {
  findIOSPlatform: typeof findIOSPlatform;
  findLanes: typeof findLanes;
  addSentryToLane: typeof addSentryToLane;
};
if (process.env["NODE_ENV"] === "test") {
  exportForTesting = {
    findIOSPlatform,
    findLanes,
    addSentryToLane,
  };
}
