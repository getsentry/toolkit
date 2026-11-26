import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

const REPOSITORY = "getsentry/toolkit";
const SOURCE = `https://github.com/${REPOSITORY}`;

/**
 * Returns human-readable problems with a published nightly manifest: it must
 * carry `version`, name this repository as its source, and have one layer for
 * each compressed binary the build produced (`files`), no more and no fewer.
 */
export function checkNightlyManifest(manifest, { version, files }) {
  const problems = [];
  const annotations = manifest.annotations ?? {};
  if (annotations.version !== version) {
    problems.push(
      `version is ${JSON.stringify(annotations.version)}, expected ${version}`,
    );
  }
  if (annotations["org.opencontainers.image.source"] !== SOURCE) {
    problems.push(
      `source is ${JSON.stringify(annotations["org.opencontainers.image.source"])}, expected ${SOURCE}`,
    );
  }
  const byName = (a, b) => a.localeCompare(b);
  const layers = (manifest.layers ?? [])
    .map((layer) => layer.annotations?.["org.opencontainers.image.title"] ?? "")
    .sort(byName);
  const expected = [...files].sort(byName);
  if (JSON.stringify(layers) !== JSON.stringify(expected)) {
    problems.push(
      `layers are ${layers.join(", ")}, expected ${expected.join(", ")}`,
    );
  }
  return problems;
}

async function getJson(url, headers) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`GET ${url} returned ${response.status}`);
  }
  return await response.json();
}

async function main() {
  const version = process.env.NIGHTLY_VERSION;
  const artifactsDir = process.env.ARTIFACTS_DIR;
  if (!version || !artifactsDir) {
    throw new Error("NIGHTLY_VERSION and ARTIFACTS_DIR are required");
  }
  const files = readdirSync(artifactsDir).filter((name) =>
    name.endsWith(".gz"),
  );

  const { token } = await getJson(
    `https://ghcr.io/token?scope=repository:${REPOSITORY}:pull`,
  );
  let failed = false;
  for (const tag of ["nightly", `nightly-${version}`]) {
    const manifest = await getJson(
      `https://ghcr.io/v2/${REPOSITORY}/manifests/${tag}`,
      {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.oci.image.manifest.v1+json",
      },
    );
    for (const problem of checkNightlyManifest(manifest, { version, files })) {
      console.error(`::error::${tag}: ${problem}`);
      failed = true;
    }
  }
  if (failed) {
    process.exit(1);
  }
  console.log(`nightly and nightly-${version} list ${files.length} binaries`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
