import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The codemod manifest whose `version` decides whether to publish. */
export const CODEMOD_MANIFEST = "packages/codemod-cli3to4/codemod.yaml";

/** Read the top-level `version` from a codemod.yaml, or null when absent. */
export function codemodVersion(manifest) {
  const match = /^version:\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/m.exec(manifest);
  return match ? match[1] : null;
}

/**
 * Whether a push changed the manifest version. A push with no usable
 * previous commit (a new branch, or a manifest that didn't exist yet) counts
 * as a change, so the first version publishes.
 */
export function versionChanged(previousManifest, currentManifest) {
  const current = codemodVersion(currentManifest);
  if (!current) {
    throw new Error(`${CODEMOD_MANIFEST} has no version`);
  }
  return (
    previousManifest === null || codemodVersion(previousManifest) !== current
  );
}

/** Return the manifest at `sha`, or null when the commit or file is missing. */
function manifestAt(sha) {
  if (!sha || /^0+$/.test(sha)) {
    return null;
  }
  try {
    return execFileSync("git", ["show", `${sha}:${CODEMOD_MANIFEST}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const changed = versionChanged(
    manifestAt(process.env.BEFORE_SHA),
    readFileSync(CODEMOD_MANIFEST, "utf8"),
  );
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
  }
  console.log(`Codemod version changed: ${changed}`);
}
