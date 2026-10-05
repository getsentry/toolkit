import { readFileSync } from "node:fs";

const expectedImport = "@sentry/core/server";

for (const path of ["dist/server.js", "dist/server.cjs"]) {
  const source = readFileSync(path, "utf8");
  if (!source.includes(expectedImport)) {
    throw new Error(`${path} must preserve the ${expectedImport} import`);
  }
}
