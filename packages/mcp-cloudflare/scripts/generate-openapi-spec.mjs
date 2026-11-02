#!/usr/bin/env node

// Writes the pinned Sentry OpenAPI schema that Code Mode ships with the deploy.
// Nothing fetches or syncs the schema at runtime: bumping the pin is a pull
// request that reviews the regenerated artifact.
//
//   pnpm --filter @sentry/mcp-cloudflare generate:openapi                  # rewrite the current pin
//   pnpm --filter @sentry/mcp-cloudflare generate:openapi --commit <sha>   # move the pin

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/code-mode/generated",
);
const SOURCE = join(OUT, "source.json");
const SPEC = join(OUT, "openapi.json.txt");

const { values } = parseArgs({ options: { commit: { type: "string" } } });
const source = JSON.parse(readFileSync(SOURCE, "utf8"));
if (values.commit) {
  if (!/^[0-9a-f]{40}$/.test(values.commit)) {
    throw new Error("--commit must be a full 40-character commit SHA.");
  }
  source.commit = values.commit;
}

const url = `https://raw.githubusercontent.com/${source.repository}/${source.commit}/${source.path}`;
console.log(`Downloading ${url}`);
const response = await fetch(url);
if (!response.ok) {
  throw new Error(`Failed to download the schema: HTTP ${response.status}`);
}
const spec = await response.json();
if (!spec || typeof spec !== "object" || typeof spec.paths !== "object") {
  throw new Error("The schema has no paths object.");
}

writeFileSync(SPEC, asciiJson(JSON.stringify(spec)));
writeFileSync(SOURCE, `${JSON.stringify(source, null, 2)}\n`);

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
  `${Object.keys(spec.paths).length} paths, ${operations.length} operations at ${source.commit}`,
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
