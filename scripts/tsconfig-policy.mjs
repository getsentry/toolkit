/**
 * Finds the TypeScript programs that package type checks run, and the
 * compiler options and root files of each.
 *
 * `scripts/tsconfig-policy.test.mjs` uses this to fail when a project
 * weakens the shared policy in `tsconfig.base.json`, or when a TypeScript
 * file is in no checked program. Run `node scripts/tsconfig-policy.mjs` to
 * list every checked program with its file count.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "@typescript/typescript6";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Package scripts that CI runs as the type check, in the order
 * scripts/ci-projects.mjs looks for them. Packages use `typecheck`; the
 * tsconfig policy test enforces that.
 */
const TYPECHECK_SCRIPTS = ["typecheck", "tsc", "check"];

function toRepoPath(path) {
  return relative(ROOT, path).split("\\").join("/");
}

function parseConfig(configPath) {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(
          `${toRepoPath(configPath)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
        );
      },
    },
  );
  if (!parsed) {
    throw new Error(`Could not read ${toRepoPath(configPath)}`);
  }
  return parsed;
}

/** Effective compiler options of the shared policy. */
export function policyOptions() {
  return parseConfig(join(ROOT, "tsconfig.base.json")).options;
}

/**
 * Expand a `tsc -b` target into the configs it builds: the config itself
 * when it has root files, and every config it references.
 */
function buildTargets(configPath, seen = new Set()) {
  if (seen.has(configPath)) {
    return [];
  }
  seen.add(configPath);
  const parsed = parseConfig(configPath);
  const targets = parsed.fileNames.length > 0 ? [configPath] : [];
  for (const reference of parsed.projectReferences ?? []) {
    const referenced = ts.resolveProjectReferencePath(reference);
    targets.push(...buildTargets(referenced, seen));
  }
  return targets;
}

function configArgument(packageDir, value) {
  const path = resolve(packageDir, value);
  return existsSync(path) && !path.endsWith(".json")
    ? join(path, "tsconfig.json")
    : path;
}

/**
 * Configs that one `tsc` command line checks. Supports `-p`/`--project`,
 * `-b`/`--build` with optional targets, and a bare `tsc`.
 */
export function configsForCommand(packageDir, command) {
  const args = command.trim().split(/\s+/).slice(1);
  const build = args.some((arg) => arg === "-b" || arg === "--build");
  const configs = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "-p" || arg === "--project") {
      const value = args[index + 1];
      if (value === undefined) {
        throw new Error(`${command}: ${arg} needs a config`);
      }
      configs.push(configArgument(packageDir, value));
      index++;
    } else if (build && !arg.startsWith("-")) {
      configs.push(configArgument(packageDir, arg));
    }
  }
  if (configs.length === 0) {
    configs.push(join(packageDir, "tsconfig.json"));
  }
  return build ? configs.flatMap((config) => buildTargets(config)) : configs;
}

export function workspacePackages() {
  const output = execFileSync("pnpm", ["ls", "-r", "--depth", "-1", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return JSON.parse(output)
    .map(({ path }) => path)
    .filter((path) => path !== ROOT);
}

/**
 * Every program that a package type check runs, keyed by repository path.
 * `astro check` checks the package's tsconfig.json.
 */
export function checkedPrograms() {
  const programs = new Map();
  for (const packageDir of workspacePackages()) {
    const manifest = JSON.parse(
      readFileSync(join(packageDir, "package.json"), "utf8"),
    );
    const scripts = manifest.scripts ?? {};
    const name = TYPECHECK_SCRIPTS.find((script) => scripts[script]);
    if (name === undefined) {
      continue;
    }
    for (const command of scripts[name].split("&&")) {
      const program = command.trim().split(/\s+/)[0];
      const configs =
        program === "tsc"
          ? configsForCommand(packageDir, command)
          : command.trim().startsWith("astro check")
            ? [join(packageDir, "tsconfig.json")]
            : [];
      for (const config of configs) {
        const parsed = parseConfig(config);
        programs.set(toRepoPath(config), {
          path: config,
          package: manifest.name,
          script: name,
          options: parsed.options,
          files: parsed.fileNames.map(toRepoPath),
        });
      }
    }
  }
  return programs;
}

const EXCEPTION_MARKER = "// skipLibCheck exception:";

function extendsTargets(configPath, raw) {
  const value = raw.extends;
  const targets = value === undefined ? [] : [value].flat();
  return targets.map((target) =>
    target.startsWith(".")
      ? resolve(dirname(configPath), target)
      : createRequire(configPath).resolve(target),
  );
}

/**
 * Find the config in a program's `extends` chain that turns on
 * skipLibCheck, and the reasons its comments give. Returns undefined when
 * no config in the chain sets it.
 */
export function libCheckException(configPath) {
  const text = readFileSync(configPath, "utf8");
  const raw = ts.parseConfigFileTextToJson(configPath, text).config ?? {};
  if (raw.compilerOptions?.skipLibCheck === true) {
    const reasons = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith(EXCEPTION_MARKER))
      .map((line) => line.slice(EXCEPTION_MARKER.length).trim());
    return { config: toRepoPath(configPath), reasons };
  }
  // Later entries in `extends` win, so search them first.
  for (const target of extendsTargets(configPath, raw).reverse()) {
    const found = libCheckException(target);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** Tracked TypeScript sources, excluding dependencies and build output. */
export function trackedTypeScriptFiles() {
  const output = execFileSync(
    "git",
    ["ls-files", "--", "*.ts", "*.tsx", "*.mts", "*.cts"],
    { cwd: ROOT, encoding: "utf8" },
  );
  return output.split("\n").filter(Boolean);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  for (const [config, { package: name, script, files }] of checkedPrograms()) {
    console.log(`${config}\t${name}#${script}\t${files.length} files`);
  }
}
