/**
 * Checks the MCP Registry manifest (`server.json` at the repository root)
 * against this package and the CLI it bundles. Run `pnpm run bundle` first:
 * the env var check reads the bundled `mcp --help`.
 *
 * Schema validation against the registry's `server.schema.json` is not here:
 * the schema is not vendored, and tests do not use the network.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const packageRoot = new URL("..", import.meta.url).pathname;
const manifest = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf-8"),
);
const serverJson = JSON.parse(
  readFileSync(join(packageRoot, "../../server.json"), "utf-8"),
);
const configDir = mkdtempSync(join(tmpdir(), "sentry-mcp-test-"));
after(() => rmSync(configDir, { recursive: true, force: true }));
const npmPackage = serverJson.packages?.find(
  (entry) => entry.registryType === "npm",
);

/** Env vars the CLI's `mcp --help` lists under "Environment variables". */
function sentryEnvVarsFromHelp() {
  const result = spawnSync(
    process.execPath,
    [join(packageRoot, "dist/sentry-mcp.cjs"), "mcp", "--help"],
    {
      encoding: "utf-8",
      env: {
        PATH: process.env.PATH,
        SENTRY_CONFIG_DIR: configDir,
        SENTRY_CLI_NO_TELEMETRY: "1",
      },
      timeout: 30_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const section = result.stdout.split("Environment variables:\n")[1];
  assert.ok(section, "mcp --help lists no environment variables");
  return new Set(section.split("\n\n")[0].match(/\bSENTRY_[A-Z_]+\b/g));
}

/** Each check returns a failure message, or nothing when it passes. */
const CHECKS = {
  "name is the package's mcpName": () =>
    serverJson.name === manifest.mcpName
      ? undefined
      : `name is ${serverJson.name}, mcpName is ${manifest.mcpName}`,
  "the npm package is this stdio package": () =>
    npmPackage?.identifier === manifest.name &&
    npmPackage.transport?.type === "stdio"
      ? undefined
      : `npm package is ${JSON.stringify(npmPackage)}`,
  "repository.url is getsentry/toolkit": () =>
    serverJson.repository?.url === "https://github.com/getsentry/toolkit"
      ? undefined
      : `repository.url is ${serverJson.repository?.url}`,
  "title is set": () =>
    serverJson.title?.trim() ? undefined : "title is missing",
  "websiteUrl is set": () =>
    serverJson.websiteUrl?.startsWith("https://")
      ? undefined
      : `websiteUrl is ${serverJson.websiteUrl}`,
  "icons are set": () =>
    serverJson.icons?.length > 0 &&
    serverJson.icons.every(
      (icon) => icon.src?.startsWith("https://") && icon.mimeType,
    )
      ? undefined
      : `icons are ${JSON.stringify(serverJson.icons)}`,
  // The registry drops `false` booleans from a listing, and Craft's
  // mcp-registry target fails a release when the listing and the manifest
  // differ. Leave these fields out instead: `false` is their default.
  "no environment variable sets a boolean to false": () => {
    const spelledOut = (npmPackage?.environmentVariables ?? []).flatMap(
      (variable) =>
        Object.entries(variable)
          .filter(([, value]) => value === false)
          .map(([key]) => `${variable.name}.${key}`),
    );
    return spelledOut.length > 0
      ? `remove ${spelledOut.join(", ")}`
      : undefined;
  },
  "environment variables match the CLI": () => {
    const declared = npmPackage?.environmentVariables ?? [];
    const byName = new Map(
      declared.map((variable) => [variable.name, variable]),
    );
    const expected = sentryEnvVarsFromHelp();
    const problems = [];
    const names = new Set(byName.keys());
    if (names.symmetricDifference(expected).size > 0) {
      problems.push(
        `declares ${[...names].join(", ")}; mcp --help lists ${[...expected].join(", ")}`,
      );
    }
    // `auth login` works without a token, so the token is optional.
    const token = byName.get("SENTRY_AUTH_TOKEN");
    if (token && (token.isRequired || token.isSecret !== true)) {
      problems.push("SENTRY_AUTH_TOKEN must be optional and secret");
    }
    for (const name of ["SENTRY_HOST", "SENTRY_URL"]) {
      const variable = byName.get(name);
      if (variable && (variable.isRequired || variable.isSecret)) {
        problems.push(`${name} must be optional and not secret`);
      }
    }
    return problems.length > 0 ? problems.join("; ") : undefined;
  },
};

for (const [name, check] of Object.entries(CHECKS)) {
  test(`server.json: ${name}`, () => {
    assert.equal(check(), undefined);
  });
}
