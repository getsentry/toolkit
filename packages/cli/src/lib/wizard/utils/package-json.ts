/**
 * Read dependencies from a project's `package.json`, including versions
 * pnpm resolves from a `pnpm-workspace.yaml` catalog.
 */

import { clack } from "./clack/prompts.js";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type PackageDotJson = {
  version?: string | undefined;
  scripts?: Record<string, string | undefined>;
  dependencies?: Record<string, string> | undefined;
  devDependencies?: Record<string, string> | undefined;
  resolutions?: Record<string, string> | undefined;
  overrides?: Record<string, string> | undefined;
  pnpm?: {
    overrides?: Record<string, string> | undefined;
  };
};

type NpmPackage = {
  name: string;
  version: string;
};

type PnpmCatalogs = Record<string, Record<string, string>>;

type PnpmWorkspace = {
  catalog?: Record<string, string> | undefined;
  catalogs?: PnpmCatalogs | undefined;
};

/** Strip quotes and a trailing comment from a YAML scalar. */
function yamlScalar(raw: string): string {
  const value = raw.replace(/\s+#.*$/, "").trim();
  const quoted = /^(['"])(.*)\1$/.exec(value);
  return quoted?.[2] ?? value;
}

/**
 * Read the `catalog` and `catalogs` sections of a `pnpm-workspace.yaml`.
 *
 * Only block mappings are read: `catalog:` with `name: version` entries, and
 * `catalogs:` with a mapping of such catalogs. Everything else in the file is
 * skipped, so the wizard needs no YAML parser.
 */
export function parsePnpmWorkspaceCatalogs(content: string): PnpmWorkspace {
  const workspace: PnpmWorkspace = {};
  let section: "catalog" | "catalogs" | undefined;
  let catalogName: string | undefined;
  let namedIndent = -1;

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) {
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const entry = /^\s*(['"]?)([^'":]+)\1\s*:\s*(.*)$/.exec(line);
    if (indent === 0) {
      section =
        entry?.[2] === "catalog" || entry?.[2] === "catalogs"
          ? entry[2]
          : undefined;
      catalogName = undefined;
      namedIndent = -1;
      continue;
    }
    if (!(section && entry?.[2])) {
      continue;
    }
    const key = entry[2].trim();
    const value = yamlScalar(entry[3] ?? "");
    if (section === "catalog") {
      workspace.catalog = { ...workspace.catalog, [key]: value };
    } else if (namedIndent < 0 || indent <= namedIndent) {
      namedIndent = indent;
      catalogName = key;
    } else if (catalogName) {
      const catalogs = workspace.catalogs ?? {};
      catalogs[catalogName] = { ...catalogs[catalogName], [key]: value };
      workspace.catalogs = catalogs;
    }
  }
  return workspace;
}

/**
 * Finds and parses the pnpm-workspace.yaml file to extract catalog definitions.
 * Searches up to 10 parent directories from the current working directory.
 * Returns null if the file doesn't exist or can't be parsed.
 */
function getPnpmWorkspace(): PnpmWorkspace | null {
  let currentDir = process.cwd();
  const maxLevels = 10;

  for (let i = 0; i < maxLevels; i++) {
    const workspaceFile = path.join(currentDir, "pnpm-workspace.yaml");

    if (existsSync(workspaceFile)) {
      const content = readFileSync(workspaceFile, "utf-8");

      return parsePnpmWorkspaceCatalogs(content);
    }

    const parentDir = path.dirname(currentDir);

    // Stop if we've reached the root directory
    if (parentDir === currentDir) {
      break;
    }

    currentDir = parentDir;
  }

  clack.log.error("Could not find pnpm-workspace.yaml.");

  return null;
}

/**
 * Resolves a catalog reference (e.g., "catalog:" or "catalog:sveltekit") to the actual version.
 * - "catalog:" refers to the default catalog (workspace.catalog)
 * - "catalog:customcatalog" refers to a named catalog (workspace.catalogs.customcatalog)
 * Returns the actual version if found, or undefined if the catalog or package doesn't exist.
 */
function resolveCatalogVersion(
  catalogRef: string,
  packageName: string,
): string | undefined {
  const catalogName = catalogRef.replace(/^catalog:/, "");
  const workspace = getPnpmWorkspace();

  if (!workspace) {
    return undefined;
  }

  const catalog =
    catalogName === "" ? workspace.catalog : workspace.catalogs?.[catalogName];

  return catalog?.[packageName];
}

/**
 * Checks if @param packageJson has any of the @param packageNamesList package names
 * listed as a dependency or devDependency.
 * If so, it returns the first package name that is found, including the
 * version (range) specified in the package.json.
 */
export function findInstalledPackageFromList(
  packageNamesList: string[],
  packageJson: PackageDotJson,
): NpmPackage | undefined {
  return packageNamesList
    .map((packageName) => ({
      name: packageName,
      version: getPackageVersion(packageName, packageJson),
    }))
    .find((sdkPackage): sdkPackage is NpmPackage => !!sdkPackage.version);
}

export function hasPackageInstalled(
  packageName: string,
  packageJson: PackageDotJson,
): boolean {
  return getPackageVersion(packageName, packageJson) !== undefined;
}

export function getPackageVersion(
  packageName: string,
  packageJson: PackageDotJson,
): string | undefined {
  const rawVersion =
    packageJson.dependencies?.[packageName] ||
    packageJson.devDependencies?.[packageName];

  if (!rawVersion) {
    return undefined;
  }

  const version = rawVersion.startsWith("catalog:")
    ? resolveCatalogVersion(rawVersion, packageName)
    : rawVersion;

  return version;
}
