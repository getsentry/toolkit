#!/usr/bin/env node

// Writes the Sentry OpenAPI schema that Code Mode ships with the deploy.
// Nothing fetches or syncs the schema at runtime. The pin is the `@sentry/api`
// version in the pnpm catalog, the same API release the CLI's `sentry api` and
// `sentry schema` are built from: bump the catalog, install, then run
//
//   pnpm --filter @sentry/mcp-cloudflare generate:openapi
//
// and review the regenerated artifact in the pull request.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/code-mode/generated",
);

// The package exports no package.json; its entry point sits in dist/.
const entry = fileURLToPath(import.meta.resolve("@sentry/api"));
const manifest = JSON.parse(
  readFileSync(join(dirname(entry), "../package.json"), "utf8"),
);
const repository = manifest.repository.url.match(
  /github\.com\/([^/]+\/[^/.]+)/,
)[1];
const source = {
  package: manifest.name,
  version: manifest.version,
  repository,
  path: "openapi-derefed.json",
};

// sentry-api-schema tags each @sentry/api release with its version.
const url = `https://raw.githubusercontent.com/${source.repository}/${source.version}/${source.path}`;
console.log(`Downloading ${url}`);
const response = await fetch(url);
if (!response.ok) {
  throw new Error(`Failed to download the schema: HTTP ${response.status}`);
}
const spec = await response.json();
if (!spec || typeof spec !== "object" || typeof spec.paths !== "object") {
  throw new Error("The schema has no paths object.");
}

writeFileSync(join(OUT, "openapi.json.txt"), asciiJson(JSON.stringify(spec)));
writeFileSync(join(OUT, "source.json"), `${JSON.stringify(source, null, 2)}\n`);

const operations = Object.values(spec.paths).flatMap((item) =>
  Object.keys(item).filter((key) =>
    [
      "get",
      "put",
      "post",
      "delete",
      "options",
      "head",
      "patch",
      "trace",
    ].includes(key),
  ),
);
console.log(
  `${Object.keys(spec.paths).length} paths, ${operations.length} operations from ${source.package}@${source.version}`,
);

/**
 * The same JSON with every character above U+007F escaped, so V8 keeps the
 * string at one byte per character in every isolate that holds it.
 */
function asciiJson(json) {
  return json.replace(
    /[\u0080-￿]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
