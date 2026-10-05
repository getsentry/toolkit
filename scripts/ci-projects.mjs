/**
 * Builds the per-project CI matrix from the pnpm workspace and package scripts.
 *
 * Package-specific CI exceptions belong in `package.json#sentryCi` so adding or
 * renaming a workspace project never requires editing the workflow itself.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, posix, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

const CI_CONFIG_FIELDS = new Set([
  "build",
  "coverage",
  "dependencies",
  "e2e",
  "enabled",
  "junit",
  "lint",
  "npmRuntime",
  "policy",
  "prepare",
  "roles",
  "test",
  "typecheck",
]);
const SAFE_BINARY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_ROLE = /^[a-z][a-z0-9-]*$/;
const DRIVE_QUALIFIED_PATH = /^[a-zA-Z]:/;
const ACTION_PATH_DELIMITERS = new Set([
  ",",
  "!",
  "\\",
  "*",
  "?",
  "[",
  "]",
  "{",
  "}",
]);
const JUNIT_OUTPUT_FILE = /(?:^|\s)--outputFile(?:\.junit)?=([^\s]+)/;

function toPosixPath(value) {
  return value.split(sep).join("/");
}

function optionalScript(scripts, configured, candidates) {
  if (configured === false) {
    return "";
  }
  if (typeof configured === "string") {
    if (!scripts[configured]) {
      throw new Error(`Configured CI script '${configured}' does not exist`);
    }
    return configured;
  }
  if (configured !== undefined) {
    throw new Error("CI script overrides must be a script name or false");
  }
  return candidates.find((candidate) => scripts[candidate]) ?? "";
}

function safeRelativePath(value, field) {
  const hasUnsafeDelimiter =
    typeof value === "string" &&
    [...value].some((character) => {
      const codeUnit = character.charCodeAt(0);
      return (
        codeUnit <= 0x1f ||
        codeUnit === 0x7f ||
        ACTION_PATH_DELIMITERS.has(character)
      );
    });
  if (
    typeof value !== "string" ||
    value === "" ||
    hasUnsafeDelimiter ||
    DRIVE_QUALIFIED_PATH.test(value) ||
    posix.isAbsolute(value) ||
    value.split("/").includes("..")
  ) {
    throw new Error(`${field} must be a safe relative path`);
  }
  const normalized = posix.normalize(value.replace(/^\.\//, ""));
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`${field} must be a safe relative path`);
  }
  return normalized;
}

function projectFile(path, value, field) {
  const projectPath = safeRelativePath(path, "workspace project path");
  const filePath = safeRelativePath(value, `package.json#sentryCi.${field}`);
  const joined = posix.join(projectPath, filePath);
  if (!joined.startsWith(`${projectPath}/`)) {
    throw new Error(
      `package.json#sentryCi.${field} must stay within the project`,
    );
  }
  return joined;
}

function runtimeBinary(packageName, bin, npmRuntime) {
  if (!npmRuntime) {
    return "";
  }

  const names =
    typeof bin === "string"
      ? [packageName.slice(packageName.lastIndexOf("/") + 1)]
      : bin && typeof bin === "object" && !Array.isArray(bin)
        ? Object.keys(bin)
        : [];
  if (names.length !== 1 || !SAFE_BINARY_NAME.test(names[0])) {
    throw new Error(
      `${packageName} must define exactly one safe package binary for sentryCi.npmRuntime`,
    );
  }
  return names[0];
}

function readCiConfig(manifest) {
  const config = manifest.sentryCi ?? {};
  if (!config || Array.isArray(config) || typeof config !== "object") {
    throw new Error("package.json#sentryCi must be an object");
  }
  if (
    config.dependencies !== undefined &&
    (!Array.isArray(config.dependencies) ||
      config.dependencies.some((dependency) => typeof dependency !== "string"))
  ) {
    throw new Error(
      "package.json#sentryCi.dependencies must be an array of package names",
    );
  }
  if (
    config.roles !== undefined &&
    (!Array.isArray(config.roles) ||
      config.roles.length === 0 ||
      config.roles.some(
        (role) => typeof role !== "string" || !SAFE_ROLE.test(role),
      ) ||
      new Set(config.roles).size !== config.roles.length)
  ) {
    throw new Error(
      "package.json#sentryCi.roles must contain unique safe role names",
    );
  }
  for (const field of Object.keys(config)) {
    if (!CI_CONFIG_FIELDS.has(field)) {
      throw new Error(`Unknown package.json#sentryCi field: ${field}`);
    }
  }
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
    throw new Error("package.json#sentryCi.enabled must be a boolean");
  }
  for (const field of ["coverage", "junit"]) {
    if (
      config[field] !== undefined &&
      config[field] !== false &&
      typeof config[field] !== "string"
    ) {
      throw new Error(`package.json#sentryCi.${field} must be a path or false`);
    }
  }
  return config;
}

/** Build and validate the workspace dependency graph. */
export function buildProjects(entries) {
  const names = new Set();
  const paths = new Set();
  const projects = entries.map(({ manifest, path: rawPath }) => {
    const path = safeRelativePath(rawPath, "workspace project path");
    if (!manifest.name || typeof manifest.name !== "string") {
      throw new Error(`${path}/package.json has no package name`);
    }
    if (names.has(manifest.name)) {
      throw new Error(`Duplicate workspace package name: ${manifest.name}`);
    }
    if (paths.has(path)) {
      throw new Error(`Duplicate workspace package path: ${path}`);
    }
    names.add(manifest.name);
    paths.add(path);

    const scripts = manifest.scripts ?? {};
    const config = readCiConfig(manifest);
    const test = optionalScript(scripts, config.test, [
      "test:ci",
      "test:unit",
      "test",
    ]);
    const npmRuntime = optionalScript(scripts, config.npmRuntime, []);
    const junitOutput = scripts[test]?.match(JUNIT_OUTPUT_FILE)?.[1];
    const coverage =
      config.coverage === false
        ? ""
        : typeof config.coverage === "string"
          ? projectFile(path, config.coverage, "coverage")
          : test !== "" && scripts[test]?.includes("coverage")
            ? `${path}/coverage/lcov.info`
            : "";
    const junit =
      config.junit === false
        ? ""
        : typeof config.junit === "string"
          ? projectFile(path, config.junit, "junit")
          : test !== "" &&
              scripts[test]?.includes("reporter=junit") &&
              junitOutput
            ? projectFile(path, junitOutput, "junit")
            : "";

    return {
      name: manifest.name,
      path,
      enabled: config.enabled !== false,
      roles: config.roles ?? [],
      dependencies: new Set(config.dependencies ?? []),
      prepare: optionalScript(scripts, config.prepare, ["ci:prepare"]),
      build: optionalScript(scripts, config.build, ["build"]),
      lint: optionalScript(scripts, config.lint, ["lint"]),
      typecheck: optionalScript(scripts, config.typecheck, [
        "typecheck",
        "tsc",
        "check",
      ]),
      test,
      e2e: optionalScript(scripts, config.e2e, ["ci:e2e", "test:e2e"]),
      policy: optionalScript(scripts, config.policy, ["ci:policy"]),
      npmRuntime,
      runtimeBin: runtimeBinary(manifest.name, manifest.bin, npmRuntime),
      coverage,
      junit,
    };
  });

  const projectNames = new Set(projects.map((project) => project.name));
  const roleOwners = new Map();
  for (const project of projects) {
    for (const role of project.roles) {
      if (roleOwners.has(role)) {
        throw new Error(
          `CI role '${role}' belongs to both ${roleOwners.get(role)} and ${project.name}`,
        );
      }
      roleOwners.set(role, project.name);
    }
  }
  for (const [index, { manifest }] of entries.entries()) {
    const project = projects[index];
    for (const field of DEPENDENCY_FIELDS) {
      for (const dependency of Object.keys(manifest[field] ?? {})) {
        if (projectNames.has(dependency)) {
          project.dependencies.add(dependency);
        }
      }
    }
    for (const dependency of project.dependencies) {
      if (!projectNames.has(dependency)) {
        throw new Error(
          `${project.name} declares unknown CI dependency '${dependency}'`,
        );
      }
      if (dependency === project.name) {
        throw new Error(`${project.name} cannot depend on itself`);
      }
    }
  }

  return projects.sort((left, right) => left.path.localeCompare(right.path));
}

/** Resolve specialized workflow roles without embedding package names or paths. */
export function findProjectsByRole(projects, roles) {
  if (
    !Array.isArray(roles) ||
    roles.length === 0 ||
    roles.some((role) => typeof role !== "string" || !SAFE_ROLE.test(role)) ||
    new Set(roles).size !== roles.length
  ) {
    throw new Error("Requested CI roles must be unique safe role names");
  }

  return Object.fromEntries(
    roles.map((role) => {
      const matches = projects.filter((project) =>
        project.roles.includes(role),
      );
      if (matches.length !== 1) {
        throw new Error(`CI role '${role}' must belong to exactly one project`);
      }
      const [project] = matches;
      return [role, { name: project.name, path: project.path }];
    }),
  );
}

/** Select directly changed projects and every transitive workspace consumer. */
export function selectAffectedProjects(projects, changedFiles, eventName) {
  if (eventName !== "pull_request") {
    return projects.filter((project) => project.enabled);
  }

  const selected = new Set();
  const changedProjects = changedFiles.map(
    (file) =>
      projects
        .filter(
          (candidate) =>
            file === candidate.path || file.startsWith(`${candidate.path}/`),
        )
        .sort((left, right) => right.path.length - left.path.length)[0],
  );
  for (const project of changedProjects) {
    if (project) {
      selected.add(project.name);
    }
  }

  // MCP repository docs are checked by the quality job, not deployed by a project.
  if (
    changedProjects.some(
      (project, index) =>
        project === undefined && !changedFiles[index].startsWith("docs/"),
    )
  ) {
    return projects.filter((project) => project.enabled);
  }

  const pending = [...selected];
  for (const changedProject of pending) {
    for (const project of projects) {
      if (
        !selected.has(project.name) &&
        project.dependencies.has(changedProject)
      ) {
        selected.add(project.name);
        pending.push(project.name);
      }
    }
  }

  return projects.filter(
    (project) => project.enabled && selected.has(project.name),
  );
}

/** Convert selected projects to values safe to pass through a GitHub matrix. */
export function buildMatrix(projects) {
  const runnableProjects = projects.filter((project) =>
    [
      project.prepare,
      project.build,
      project.lint,
      project.typecheck,
      project.test,
      project.e2e,
      project.policy,
      project.npmRuntime,
      project.coverage,
      project.junit,
    ].some((value) => value !== ""),
  );
  if (runnableProjects.length > 256) {
    throw new Error("GitHub Actions matrices support at most 256 projects");
  }
  const slugs = new Set();
  const include = runnableProjects.map((project) => {
    const slug = project.name
      .replace(/^@/, "")
      .replaceAll(/[^a-zA-Z0-9]+/g, "-");
    if (slugs.has(slug)) {
      throw new Error(`Duplicate CI project slug: ${slug}`);
    }
    slugs.add(slug);
    return {
      name: project.name,
      path: project.path,
      slug,
      prepare: project.prepare,
      build: project.build,
      lint: project.lint,
      typecheck: project.typecheck,
      test: project.test,
      e2e: project.e2e,
      policy: project.policy,
      npmRuntime: project.npmRuntime,
      runtimeBin: project.runtimeBin,
      coverage: project.coverage,
      coverageDirectory:
        project.coverage === "" ? "" : dirname(project.coverage),
      junit: project.junit,
    };
  });
  return { include };
}

export function buildRuntimeMatrix(projectMatrix, nodeVersions) {
  if (!Array.isArray(projectMatrix?.include) || !Array.isArray(nodeVersions)) {
    throw new Error("Runtime matrix inputs must be arrays");
  }
  if (
    nodeVersions.length === 0 ||
    new Set(nodeVersions).size !== nodeVersions.length ||
    nodeVersions.some((version) => !/^\d+\.\d+\.\d+$/.test(version))
  ) {
    throw new Error("Runtime Node versions must be unique exact versions");
  }
  const include = projectMatrix.include.flatMap((project) =>
    nodeVersions.map((node) => ({ node, project })),
  );
  if (include.length > 256) {
    throw new Error("GitHub Actions matrices support at most 256 runtime jobs");
  }
  return { include };
}

function parseArguments(argv) {
  const options = {};
  for (const [index, key] of argv.entries()) {
    if (index % 2 !== 0) {
      continue;
    }
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument: ${key ?? "<missing>"}`);
    }
    options[key.slice(2)] = value;
  }
  return options;
}

function validateCommit(value, name) {
  if (!/^[0-9a-f]{40,64}$/i.test(value)) {
    throw new Error(`${name} must be a full commit SHA`);
  }
}

function discoverProjects(root) {
  const listed = JSON.parse(
    execFileSync("pnpm", ["list", "--recursive", "--depth", "-1", "--json"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
  if (!Array.isArray(listed)) {
    throw new Error("pnpm returned an invalid workspace project list");
  }

  const rootPath = resolve(root);
  const entries = listed
    .map((item) => {
      const absolutePath = resolve(item.path);
      const path = toPosixPath(relative(rootPath, absolutePath));
      if (path === "" || path.startsWith("../") || path === "..") {
        return null;
      }
      const manifest = JSON.parse(
        readFileSync(resolve(absolutePath, "package.json"), "utf8"),
      );
      return { manifest, path };
    })
    .filter(Boolean);
  return buildProjects(entries);
}

function changedFiles(root, base, head) {
  validateCommit(base, "base");
  validateCommit(head, "head");
  const output = execFileSync(
    "git",
    [
      "diff",
      "--name-only",
      "--no-renames",
      "--diff-filter=ACDMRTUXB",
      "-z",
      `${base}...${head}`,
    ],
    { cwd: root, encoding: "utf8" },
  );
  return output.split("\0").filter(Boolean);
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const eventName = options.event;
  const root = resolve(import.meta.dirname, "..");
  const projects = discoverProjects(root);
  if (options.roles) {
    const roles = options.roles.split(",");
    process.stdout.write(
      `${JSON.stringify(findProjectsByRole(projects, roles))}\n`,
    );
    return;
  }
  if (!eventName) {
    throw new Error("--event is required");
  }
  const files =
    eventName === "pull_request"
      ? changedFiles(root, options.base ?? "", options.head ?? "")
      : [];
  const selected = selectAffectedProjects(projects, files, eventName);
  process.stdout.write(`${JSON.stringify(buildMatrix(selected))}\n`);
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
