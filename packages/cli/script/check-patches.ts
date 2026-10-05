#!/usr/bin/env tsx
/**
 * Check Patched Dependency Versions
 *
 * Verifies that pnpm patchedDependencies target versions match installed versions.
 * Name-only keys in patchedDependencies (pnpm 10+ catalog style) apply patches
 * to whatever version resolves. If the installed version doesn't match the
 * patch file's target version, the patch may silently fail to apply.
 *
 * Mismatches are surfaced as warnings (not hard failures) because pnpm 10
 * name-only keys intentionally support version-agnostic patching — patches
 * often apply cleanly across minor/patch bumps. The warning ensures engineers
 * notice and can regenerate the patch if needed.
 *
 * Beyond version matching, this script runs CONTENT assertions that verify a
 * patch's *effect* is actually present in the installed package. This guards
 * against a class of silent failure: when a dependency is bumped and the patch
 * fails to apply (line-number/context drift), pnpm only WARNS and installs the
 * unpatched package — re-introducing whatever the patch fixed. A version-only
 * check would still pass in that case, so content assertions are the real
 * safety net.
 *
 * Known-fragile patch — @stricli/core (`-H` alias):
 *   The @stricli/core patch frees the `-H` short alias (Stricli hardcodes it
 *   for `--help-all`) so the `api` command can use `-H` for `--header`,
 *   gh-style. The patch edits exact line-context in BOTH `dist/index.js` (ESM)
 *   and `dist/index.cjs` (CJS). It WILL break on any @stricli/core version bump
 *   that shifts those lines. Upstreaming a config option for this is unlikely
 *   to be accepted, so the patch is a permanent maintenance cost: on every
 *   Stricli bump, expect to regenerate it (`pnpm patch @stricli/core`, reapply
 *   the four edits per file, `pnpm patch-commit`) and rename the patch file to
 *   the new version. This content check fails loudly if the bump silently
 *   dropped the patch.
 *
 * Usage:
 *   tsx script/check-patches.ts
 *
 * Exit codes:
 *   0 - All patch versions match (or only non-critical warnings) and all
 *       content assertions pass
 *   1 - A patched package is missing entirely, OR a content assertion failed
 *       (patch did not apply to the installed package)
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

/**
 * Read `patchedDependencies` from the workspace configuration.
 *
 * pnpm 11 reads workspace-root settings from `pnpm-workspace.yaml`.
 */
const WORKSPACE_PATH = "../../pnpm-workspace.yaml";
const PATCHED_DEPENDENCIES_SECTION = /^patchedDependencies:\n((?: {2}.+\n)*)/m;
const PATCHED_DEPENDENCY_ENTRY = /^ {2}"([^"]+)": (\S+)$/;

/**
 * Parse the quoted scalar mapping used by the workspace's patchedDependencies.
 *
 * This intentionally accepts only the narrow representation maintained in the
 * checked-in workspace file. Unexpected YAML fails closed instead of silently
 * disabling patch verification.
 */
function parsePatchedDependencies(source: string): Record<string, string> {
  const section = source.match(PATCHED_DEPENDENCIES_SECTION)?.[1];
  if (section === undefined) {
    throw new Error(`Missing patchedDependencies in ${WORKSPACE_PATH}`);
  }

  const patches: Record<string, string> = {};
  for (const line of section.trimEnd().split("\n")) {
    const entry = line.match(PATCHED_DEPENDENCY_ENTRY);
    if (!entry) {
      throw new Error(
        `Unsupported patchedDependencies entry in ${WORKSPACE_PATH}: ${line}`
      );
    }
    const [, key, patchPath] = entry;
    patches[key] = patchPath;
  }
  return patches;
}

/**
 * Resolve an installed package file to the copy THIS package actually uses.
 *
 * In a pnpm workspace, a transitive (unpatched) copy of a dependency can
 * coexist with the patched direct copy (e.g. an unpatched `@sentry/core`
 * pulled in via another dependency). A naive `node_modules/<pkg>` path may
 * point at the wrong copy. Using `require.resolve` rooted at this package
 * respects pnpm's per-package resolution and finds the patched copy the
 * `sentry` package links to.
 *
 * We resolve the package's MAIN entry (not its `package.json`, which many
 * packages exclude from their `exports` map) and then derive the package root
 * by truncating the resolved path at the package-name segment.
 *
 * The package root is the FIRST `<pkgName>/` segment that follows the last
 * `node_modules/` boundary in the resolved path. Anchoring on `node_modules/`
 * (rather than `lastIndexOf('/<pkgName>/')`) is important: a package that
 * vendors a nested copy of itself (e.g.
 * `.../node_modules/@scope/pkg/vendor/@scope/pkg/index.js`) would otherwise
 * truncate at the wrong, inner segment.
 *
 * @param subpath - Package subpath, e.g. `@sentry/core/build/cjs/index.js`.
 * @returns Absolute path to the resolved file, or null if unresolvable.
 */
const require_ = createRequire(import.meta.url);
const mastraRequire = createRequire(require_.resolve("@mastra/client-js"));
const uiUtilsRequire = createRequire(mastraRequire.resolve("@ai-sdk/ui-utils"));

function resolvePackageFile(
  subpath: string,
  resolver: NodeJS.Require = require_
): string | null {
  const parts = subpath.split("/");
  const pkgName = subpath.startsWith("@")
    ? `${parts[0]}/${parts[1]}`
    : parts[0];
  const inner = subpath.slice(pkgName.length + 1);
  try {
    // Resolve the package's main entry to locate the exact installed copy.
    const mainEntry = resolver.resolve(pkgName);
    // The install dir is "<...>/node_modules/<pkgName>". Anchor on the last
    // "node_modules/" boundary, then take the first "<pkgName>/" after it so a
    // self-vendored nested copy can't shift the truncation point.
    const nmMarker = "/node_modules/";
    const nmIdx = mainEntry.lastIndexOf(nmMarker);
    const marker = `/${pkgName}/`;
    const searchFrom = nmIdx === -1 ? 0 : nmIdx + nmMarker.length - 1;
    const idx = mainEntry.indexOf(marker, searchFrom);
    if (idx === -1) {
      return null;
    }
    const pkgRoot = mainEntry.slice(0, idx + marker.length - 1);
    return inner ? `${pkgRoot}/${inner}` : pkgRoot;
  } catch {
    return null;
  }
}

const patches = parsePatchedDependencies(
  await readFile(WORKSPACE_PATH, "utf-8")
);
const warnings: string[] = [];
const errors: string[] = [];

/**
 * Split a patchedDependencies key into its bare package name and optional
 * version selector. pnpm supports both name-only keys (`@sentry/core`) and
 * exact-version keys (`@sentry/core@10.50.0`); the latter scopes a patch to a
 * single version so pnpm never attempts to apply it to mismatched nested copies
 * (e.g. a transitive `@sentry/core@10.60.0`), which otherwise emits a
 * "Could not apply patch" warning.
 *
 * Scoped names begin with `@`, so only an `@` after index 0 delimits a version.
 *
 * @param key - A patchedDependencies key, versioned or not.
 * @returns The bare package name and the version selector (undefined if absent).
 */
function parsePatchKey(key: string): { name: string; version?: string } {
  const atIndex = key.lastIndexOf("@");
  if (atIndex > 0) {
    return { name: key.slice(0, atIndex), version: key.slice(atIndex + 1) };
  }
  return { name: key };
}

for (const [key, patchPath] of Object.entries(patches)) {
  const { name } = parsePatchKey(key);
  // Extract version from patch path: "patches/@stricli%2Fcore@1.2.5.patch" → "1.2.5"
  // Handles pre-release versions like "1.2.3-beta.1" by matching everything after @M.N.P until .patch
  const versionMatch = patchPath.match(/@(\d+\.\d+\.\d+[^@]*)\.patch$/);
  if (!versionMatch) {
    warnings.push(
      `  ? ${name}: could not extract version from patch path "${patchPath}"`
    );
    continue;
  }
  const patchVersion = versionMatch[1];

  // Resolve installed version
  const resolver =
    key === "@ai-sdk/provider-utils@2.2.8" ? uiUtilsRequire : require_;
  const pkgJsonPath = resolvePackageFile(`${name}/package.json`, resolver);
  try {
    if (!pkgJsonPath) {
      throw new Error("unresolved");
    }
    const installed: { version: string } = JSON.parse(
      await readFile(pkgJsonPath, "utf-8")
    );
    if (installed.version !== patchVersion) {
      warnings.push(
        `  ${name}: patch targets ${patchVersion}, installed ${installed.version} — regenerate with: pnpm patch ${name}`
      );
    }
  } catch {
    errors.push(`  ${name}: not installed (expected ${patchVersion})`);
  }
}

/**
 * Content assertions: verify a patch's *effect* is present in the installed
 * package, not just that the version matches. Each entry checks either that a
 * stale (pre-patch) `staleMarker` is absent or that a `requiredMarker` (added
 * by the patch) is present in a given installed file. If the check fails, the
 * patch did not apply and we fail hard.
 *
 * @stricli/core (`-H` alias): the unpatched source registers `-H` as the
 * reserved alias for `--help-all` via
 * `checkForReservedAliases(aliases, ["h", "H"])`. After our patch that becomes
 * `["h"]`. The presence of `"H"` in that call is a reliable signal that the
 * patch did NOT apply (in either the ESM or CJS bundle).
 *
 * @stricli/core (top-level flags): the patch teaches `buildRouteScanner` to
 * recognize a host-supplied allow-list of global flags (`scanner.topLevelFlags`)
 * at any route depth, so `sentry --verbose issue list` no longer fails route
 * resolution. The allow-list itself is passed in from the app (derived from
 * GLOBAL_FLAGS) rather than hardcoded in the patch. This is a pure insertion, so
 * it's guarded by a `requiredMarker` (`matchTopLevelFlag`) that must be present
 * once patched. Its absence means global flags before a subcommand will crash.
 *
 * @stricli/core (`-v` version alias): the patch also drops Stricli's built-in
 * `-v`=version alias in `runApplication` so `-v` stays the Sentry CLI's
 * `--verbose` alias at every position; `--version` remains the version flag.
 * The stale marker is the original `inputs[0] === "-v"` version check.
 *
 * @sentry/core and @sentry/node-core: these are tree-shaking patches that strip
 * unused re-exports (AI/integration modules) from the build barrels so esbuild
 * excludes them from the bundle. They edit bundler-generated barrels and are
 * therefore especially prone to silent context drift on a version bump. Each
 * marker is a re-export the patch removes (present in the pristine package,
 * absent once patched); its presence means the strip did NOT apply and the
 * bundle will re-bloat with the AI integrations — re-introducing the dangling
 * re-export class the patch guards against.
 */
const CONTENT_ASSERTIONS: ReadonlyArray<{
  /** Installed file to inspect, relative to the resolved node_modules dir. */
  file: string;
  /** Stale marker that MUST be absent once the patch is applied. */
  staleMarker?: string;
  /**
   * Marker that MUST be present once the patch is applied. Used for patches
   * that add code (pure insertions) with no stale line to key off of.
   */
  requiredMarker?: string;
  /** Human-readable explanation shown on failure. */
  description: string;
}> = [
  {
    file: "@stricli/core/dist/index.js",
    staleMarker: 'checkForReservedAliases(aliases, ["h", "H"])',
    description:
      "@stricli/core ESM: -H alias not freed (api -H/--header will crash)",
  },
  {
    file: "@stricli/core/dist/index.cjs",
    staleMarker: 'checkForReservedAliases(aliases, ["h", "H"])',
    description:
      "@stricli/core CJS: -H alias not freed (api -H/--header will crash)",
  },
  {
    file: "@stricli/core/dist/index.js",
    requiredMarker: "matchTopLevelFlag",
    description:
      "@stricli/core ESM: top-level-flags scanner allow-list missing (global flags before a subcommand, e.g. `sentry --verbose issue list`, will fail route resolution)",
  },
  {
    file: "@stricli/core/dist/index.cjs",
    requiredMarker: "matchTopLevelFlag",
    description:
      "@stricli/core CJS: top-level-flags scanner allow-list missing (global flags before a subcommand, e.g. `sentry --verbose issue list`, will fail route resolution)",
  },
  {
    file: "@stricli/core/dist/index.js",
    staleMarker: 'inputs[0] === "--version" || inputs[0] === "-v"',
    description:
      "@stricli/core ESM: built-in `-v`=version alias not dropped (`sentry -v <command>` prints the version instead of running the command verbosely)",
  },
  {
    file: "@stricli/core/dist/index.cjs",
    staleMarker: 'inputs[0] === "--version" || inputs[0] === "-v"',
    description:
      "@stricli/core CJS: built-in `-v`=version alias not dropped (`sentry -v <command>` prints the version instead of running the command verbosely)",
  },
  {
    file: "@stricli/core/dist/index.js",
    requiredMarker: "versionRequested",
    description:
      "@stricli/core ESM: scanner `versionRequested` state missing (`--version` after a subcommand, e.g. `sentry cli --version`, will not print the version)",
  },
  {
    file: "@stricli/core/dist/index.cjs",
    requiredMarker: "versionRequested",
    description:
      "@stricli/core CJS: scanner `versionRequested` state missing (`--version` after a subcommand, e.g. `sentry cli --version`, will not print the version)",
  },
  {
    file: "@stricli/core/dist/index.js",
    requiredMarker: "renderHelp",
    description:
      "@stricli/core ESM: pluggable `renderHelp` hook missing (`sentry --help --json` will fall back to text help instead of structured JSON)",
  },
  {
    file: "@stricli/core/dist/index.cjs",
    requiredMarker: "renderHelp",
    description:
      "@stricli/core CJS: pluggable `renderHelp` hook missing (`sentry --help --json` will fall back to text help instead of structured JSON)",
  },
  {
    file: "@sentry/core/build/cjs/index.js",
    staleMarker: "exports.instrumentOpenAiClient",
    description:
      "@sentry/core CJS: tree-shaking strip not applied (AI integrations re-bundled)",
  },
  {
    file: "@sentry/core/build/esm/index.js",
    staleMarker: "from './tracing/openai/index.js'",
    description:
      "@sentry/core ESM: tree-shaking strip not applied (AI integrations re-bundled)",
  },
  {
    file: "@sentry/node-core/build/cjs/light/index.js",
    staleMarker: "exports.dedupeIntegration",
    description:
      "@sentry/node-core CJS light: integration re-export strip not applied",
  },
  {
    file: "@sentry/node-core/build/esm/light/index.js",
    staleMarker: "dedupeIntegration",
    description:
      "@sentry/node-core ESM light: integration re-export strip not applied",
  },
];

for (const assertion of CONTENT_ASSERTIONS) {
  const assertionPath = resolvePackageFile(assertion.file);
  try {
    if (!assertionPath) {
      throw new Error("unresolved");
    }
    const contents = await readFile(assertionPath, "utf-8");
    if (assertion.staleMarker && contents.includes(assertion.staleMarker)) {
      errors.push(
        `  ${assertion.description} — patch not applied to ${assertion.file} (regenerate the patch for the current dependency version)`
      );
    }
    if (
      assertion.requiredMarker &&
      !contents.includes(assertion.requiredMarker)
    ) {
      errors.push(
        `  ${assertion.description} — patch not applied to ${assertion.file} (regenerate the patch for the current dependency version)`
      );
    }
  } catch {
    errors.push(
      `  ${assertion.description} — could not read ${assertion.file} (run pnpm install)`
    );
  }
}

try {
  const { createStatusCodeErrorResponseHandler } = uiUtilsRequire(
    "@ai-sdk/provider-utils"
  ) as {
    createStatusCodeErrorResponseHandler: () => (options: {
      response: Response;
      url: string;
      requestBodyValues: unknown;
    }) => Promise<unknown>;
  };
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    }),
    {
      status: 500,
      headers: { "content-length": String(2 * 1024 * 1024 * 1024 + 1) },
    }
  );

  await createStatusCodeErrorResponseHandler()({
    response,
    url: "https://example.invalid/oversized-response",
    requestBodyValues: {},
  }).then(
    () => {
      errors.push(
        "  @ai-sdk/provider-utils: oversized response was accepted (resource-limit patch not applied)"
      );
    },
    () => {
      if (!cancelled) {
        errors.push(
          "  @ai-sdk/provider-utils: oversized response body was not cancelled"
        );
      }
    }
  );
} catch (error) {
  errors.push(
    `  @ai-sdk/provider-utils: could not verify response-size limit (${String(error)})`
  );
}

// Emit GitHub Actions annotations for CI visibility
const isCI = !!process.env.CI;
for (const w of warnings) {
  if (isCI) {
    console.log(`::warning::Patch version mismatch:${w.trim()}`);
  } else {
    console.warn(`⚠ ${w}`);
  }
}

if (errors.length > 0) {
  console.error("✗ Patch problems detected:");
  console.error("");
  for (const e of errors) {
    console.error(e);
  }
  console.error("");
  console.error(
    "A missing package is fixed by `pnpm install`. A content-assertion failure"
  );
  console.error(
    "means the patch no longer applies (likely a dependency bump) — regenerate"
  );
  console.error("it with `pnpm patch <name>` and re-commit.");
  process.exit(1);
}

if (warnings.length === 0) {
  console.log("✓ All patched dependency versions match installed versions");
} else {
  console.log(
    `✓ Patches applied (${warnings.length} version mismatch warning(s) — consider regenerating)`
  );
}
