import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function computeNightlyVersion(version, timestamp) {
  const base = /^(\d+\.\d+\.\d+)(?:-dev\.\d+)?$/.exec(version);
  if (
    !base ||
    !/^[1-9]\d*$/.test(timestamp) ||
    !Number.isSafeInteger(Number(timestamp))
  ) {
    throw new Error(
      "Invalid CLI version or commit timestamp for nightly build",
    );
  }
  return `${base[1]}-dev.${timestamp}`;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { version } = JSON.parse(
    readFileSync("packages/cli/package.json", "utf8"),
  );
  const timestamp = execFileSync(
    "git",
    ["show", "-s", "--format=%ct", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  const nightly = computeNightlyVersion(version, timestamp);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${nightly}\n`);
  }
  console.log(`Nightly version: ${nightly}`);
}
