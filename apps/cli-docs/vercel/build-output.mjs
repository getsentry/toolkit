// Packages the built site (apps/cli-docs/dist) as Vercel Build Output API v3:
// the static files, the routes below, and the Edge Function behind
// /install/<handoff code> and /install.ps1/<handoff code>.
// Usage: node build-output.mjs <output dir, e.g. .vercel/output>
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HANDOFF_CODE } from "./install-handoff.mjs";

const HANDOFF_FUNCTION = "install-handoff";

const routes = [
  // Browsers that open /install or /install.ps1 get the highlighted source
  // page; curl, wget, and irm still get the raw script.
  { src: "^/install(\\.ps1)?$", headers: { Vary: "Accept" }, continue: true },
  {
    src: "^/install(\\.ps1)?$",
    has: [{ type: "header", key: "accept", value: { re: ".*text/html.*" } }],
    dest: "/install-source/install$1/index.html",
    check: true,
  },
  // Only the raw script is plain text; the browser page above stays HTML.
  {
    src: "^/install$",
    missing: [{ type: "header", key: "accept", value: { re: ".*text/html.*" } }],
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    continue: true,
  },
  {
    src: `^/(install|install\\.ps1)/(${HANDOFF_CODE.source.slice(1, -1)})$`,
    dest: `/${HANDOFF_FUNCTION}?script=$1&code=$2`,
  },
];

export function buildOutput(distDir, outputDir) {
  rmSync(outputDir, { recursive: true, force: true });
  cpSync(distDir, join(outputDir, "static"), { recursive: true });
  writeFileSync(
    join(outputDir, "config.json"),
    `${JSON.stringify({ version: 3, routes })}\n`,
  );

  const functionDir = join(outputDir, "functions", `${HANDOFF_FUNCTION}.func`);
  mkdirSync(functionDir, { recursive: true });
  writeFileSync(
    join(functionDir, ".vc-config.json"),
    `${JSON.stringify({ runtime: "edge", entrypoint: "index.js" })}\n`,
  );
  const handler = readFileSync(new URL("./install-handoff.mjs", import.meta.url), "utf8");
  const scripts = {
    install: readFileSync(join(distDir, "install"), "utf8"),
    "install.ps1": readFileSync(join(distDir, "install.ps1"), "utf8"),
  };
  writeFileSync(
    join(functionDir, "index.js"),
    `${handler}\nexport default createHandler(${JSON.stringify(scripts)});\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outputDir = process.argv[2];
  if (!outputDir) {
    console.error("usage: node build-output.mjs <output dir>");
    process.exit(2);
  }
  buildOutput(fileURLToPath(new URL("../dist", import.meta.url)), outputDir);
}
