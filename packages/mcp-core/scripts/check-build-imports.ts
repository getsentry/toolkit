import { readFileSync } from "node:fs";

const expectedImport = "@sentry/core/server";
const path = "dist/server.js";

const source = readFileSync(path, "utf8");
if (!source.includes(expectedImport)) {
  throw new Error(`${path} must preserve the ${expectedImport} import`);
}
