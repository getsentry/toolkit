/** Auto-detect the project's development server command from filesystem markers. */

import { existsSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "./logger.js";
import { whichSync } from "./which.js";

export type DetectedCommand = {
  /** The command args to pass to spawn. */
  args: string[];
  /** Human label for what was detected (e.g., "package.json scripts.dev"). */
  source: string;
};

/** Ordered list of npm script names to look for in package.json. */
const SCRIPT_PRIORITY = ["dev", "develop", "serve", "start"] as const;

/** Whitespace splitter — hoisted to avoid recreating on every call. */
const WHITESPACE_RE = /\s+/;

/**
 * Matches script values that use shell features (env-var assignments,
 * variable expansion, operators, redirects, quotes) which cannot be
 * tokenized by simple whitespace splitting and must be run via a shell.
 */
const SHELL_FEATURES_RE = /^[A-Za-z_]\w*=\S|&&|\|\||[|><;$"'`]/;

/** Inputs that `detectDevCommand` reads besides the filesystem. */
export type DetectOptions = {
  /** Env to read `VIRTUAL_ENV` and `FLASK_APP` from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Platform that picks venv paths and the shell. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
};

/**
 * Detect the project's dev command by inspecting filesystem markers in priority order.
 *
 * Detection priority:
 * 1. package.json scripts (dev > develop > serve > start)
 * 2. manage.py (Django)
 * 3. app.py, then main.py (FastAPI, Flask, or a plain Python script)
 * 4. wsgi.py (Flask, or a script with a `__main__` guard)
 * 5. FLASK_APP env var, in a project with a Python marker (Flask)
 * 6. go.mod (Go)
 * 7. docker-compose.yml / compose.yml (Docker Compose)
 *
 * Python commands run the project's virtualenv interpreter when one exists,
 * even if it is not activated (see `findPython`).
 *
 * @param cwd - The project root directory to scan
 * @returns The detected command, or null if nothing was found
 */
export async function detectDevCommand(
  cwd: string,
  options: DetectOptions = {},
): Promise<DetectedCommand | null> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  let found: string | undefined;
  // Looked up on first use: the PATH lookup spawns a process.
  const python = () => (found ??= findPython(cwd, env, platform));
  const result =
    (await tryPackageJson(cwd, platform)) ??
    tryDjango(cwd, python) ??
    (await tryPythonApp(cwd, "app.py", python, true)) ??
    (await tryPythonApp(cwd, "main.py", python, true)) ??
    (await tryPythonApp(cwd, "wsgi.py", python, false)) ??
    tryFlaskAppEnv(cwd, env, python) ??
    (await tryGoMod(cwd)) ??
    (await tryDockerCompose(cwd));
  return result;
}

/** Split a script value into spawn args, wrapping in a shell if needed. */
function parseScriptArgs(value: string, platform: NodeJS.Platform): string[] {
  const trimmed = value.trim();
  if (SHELL_FEATURES_RE.test(trimmed)) {
    return platform === "win32"
      ? ["cmd", "/c", trimmed]
      : ["sh", "-c", trimmed];
  }
  return trimmed.split(WHITESPACE_RE);
}

/** Try to detect a dev command from package.json scripts. */
async function tryPackageJson(
  cwd: string,
  platform: NodeJS.Platform,
): Promise<DetectedCommand | null> {
  try {
    const pkgPath = join(cwd, "package.json");
    const raw = await readFile(pkgPath, "utf-8").catch(() => null);
    if (raw === null) {
      return null;
    }
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts;
    if (!scripts || typeof scripts !== "object") {
      return null;
    }
    for (const name of SCRIPT_PRIORITY) {
      const value = scripts[name];
      if (typeof value === "string" && value.trim().length > 0) {
        const args = parseScriptArgs(value, platform);
        return {
          args,
          source: `package.json scripts.${name}`,
        };
      }
    }
    return null;
  } catch (error) {
    logger.debug("Failed to read package.json for dev script detection", error);
    return null;
  }
}

/** Returns the Python interpreter to run, found on first call. */
type PythonLookup = () => string;

/**
 * Find the Python to run: the project's virtualenv when it has one, so an
 * unactivated venv still gets its own packages. Checks `VIRTUAL_ENV`, then
 * `.venv/`, then `venv/`, and takes the first with an interpreter. Without a
 * venv, `python`, or `python3` when only that is on PATH (Ubuntu and Debian
 * ship no `python`). Falls back to `python` when neither is found, so the
 * not-found error names the usual command.
 */
function findPython(
  cwd: string,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): string {
  const [binDir, exe] =
    platform === "win32" ? ["Scripts", ".exe"] : ["bin", ""];
  for (const root of [env.VIRTUAL_ENV, join(cwd, ".venv"), join(cwd, "venv")]) {
    if (!root) {
      continue;
    }
    const python = join(root, binDir, `python${exe}`);
    if (existsSync(python)) {
      return python;
    }
  }
  return whichSync("python") || !whichSync("python3") ? "python" : "python3";
}

/** Check for manage.py and return `python manage.py runserver`. */
function tryDjango(cwd: string, python: PythonLookup): DetectedCommand | null {
  if (!existsSync(join(cwd, "manage.py"))) {
    return null;
  }
  return {
    args: [python(), "manage.py", "runserver"],
    source: "manage.py",
  };
}

/** Files that mark a directory as a Python project. */
const PYTHON_MARKERS = [
  "app.py",
  "main.py",
  "wsgi.py",
  "pyproject.toml",
  "requirements.txt",
] as const;

/**
 * With `FLASK_APP` set, let `flask run` load the app it names. Only in a
 * Python project, so a `FLASK_APP` exported from a shell profile does not
 * take over a Go or Docker Compose project.
 */
function tryFlaskAppEnv(
  cwd: string,
  env: Record<string, string | undefined>,
  python: PythonLookup,
): DetectedCommand | null {
  if (
    !env.FLASK_APP ||
    !PYTHON_MARKERS.some((file) => existsSync(join(cwd, file)))
  ) {
    return null;
  }
  return {
    args: [python(), "-m", "flask", "run"],
    source: "FLASK_APP (Flask)",
  };
}

/** Matches `if __name__ == "__main__":`, a file that starts its own server. */
const MAIN_GUARD_RE = /^if\s+__name__\s*==\s*["']__main__["']\s*:/m;

/** Captures the top-level variable a FastAPI app is assigned to, as in `api = FastAPI()`. */
const FASTAPI_APP_RE = /^(\w+)\s*(?::[^=\n]+)?=\s*(?:fastapi\.)?FastAPI\(/m;

/** Captures the top-level variable a Flask app is assigned to, as in `app = Flask(__name__)`. */
const FLASK_APP_RE = /^(\w+)\s*(?::[^=\n]+)?=\s*(?:flask\.)?Flask\(/m;

/**
 * Captures a top-level `app` or `application` assignment, such as
 * `app = create_app()`, for an app whose framework only the declared
 * dependencies name.
 */
const APP_VARIABLE_RE = /^(app|application)\s*(?::[^=\n]+)?=/m;

/**
 * Detect a Python web app in `filename`.
 *
 * A file with a `__main__` guard starts its own server, so it always runs as
 * `python <file>`. Otherwise a FastAPI or Flask app has no code that serves
 * it, and `python <file>` would exit right away, so its server runs it:
 * uvicorn for FastAPI, `flask run` for Flask. Uvicorn rather than
 * `fastapi dev`, because plain `fastapi` installs a `fastapi` script that
 * fails without `fastapi[standard]`, and any venv that has fastapi-cli has
 * uvicorn too.
 *
 * A top-level `FastAPI(` or `Flask(` assignment names the framework and the
 * app variable. Failing that, a top-level `app` or `application` assignment
 * uses the framework the project declares. A file with neither runs as a
 * script only when `runAsScript` is set.
 */
async function tryPythonApp(
  cwd: string,
  filename: string,
  python: PythonLookup,
  runAsScript: boolean,
): Promise<DetectedCommand | null> {
  const source = await readFile(join(cwd, filename), "utf-8").catch(() => null);
  if (source === null) {
    return null;
  }
  const script = { args: [python(), filename], source: filename };
  if (MAIN_GUARD_RE.test(source)) {
    return script;
  }
  const app = await findPythonApp(cwd, source);
  if (!app) {
    return runAsScript ? script : null;
  }
  const ref = `${filename.slice(0, -".py".length)}:${app.variable}`;
  return {
    args:
      app.framework === "FastAPI"
        ? [python(), "-m", "uvicorn", ref, "--reload"]
        : [python(), "-m", "flask", "--app", ref, "run"],
    source: `${filename} (${app.framework})`,
  };
}

/** A web framework `local run` knows how to serve. */
type PythonFramework = "FastAPI" | "Flask";

/** The app object in a Python file, found by `findPythonApp`. */
type PythonApp = {
  /** Framework that serves it. */
  framework: PythonFramework;
  /** Top-level variable that holds it. */
  variable: string;
};

/** Find the FastAPI or Flask app that `source` defines at top level. */
async function findPythonApp(
  cwd: string,
  source: string,
): Promise<PythonApp | null> {
  const fastapi = FASTAPI_APP_RE.exec(source)?.[1];
  if (fastapi) {
    return { framework: "FastAPI", variable: fastapi };
  }
  const flask = FLASK_APP_RE.exec(source)?.[1];
  if (flask) {
    return { framework: "Flask", variable: flask };
  }
  const variable = APP_VARIABLE_RE.exec(source)?.[1];
  const framework = variable ? await declaredFramework(cwd) : null;
  return variable && framework ? { framework, variable } : null;
}

/**
 * The web framework that pyproject.toml or requirements.txt declares, or
 * null when they declare neither or both.
 */
async function declaredFramework(cwd: string): Promise<PythonFramework | null> {
  const [pyproject, requirements] = await Promise.all(
    ["pyproject.toml", "requirements.txt"].map((file) =>
      readFile(join(cwd, file), "utf-8").catch(() => ""),
    ),
  );
  const names = new Set([
    ...pyprojectDependencies(pyproject ?? ""),
    ...requirementsDependencies(requirements ?? ""),
  ]);
  const hasFastapi = names.has("fastapi");
  const hasFlask = names.has("flask");
  if (hasFastapi === hasFlask) {
    return null;
  }
  return hasFastapi ? "FastAPI" : "Flask";
}

/** Captures the package name at the start of a requirement, as `flask` in `Flask[async]>=3`. */
const REQUIREMENT_NAME_RE = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/;

/** Captures each quoted string on a TOML line. */
const TOML_STRING_RE = /["']([^"']*)["']/g;

/** Captures a TOML table header, as `tool.poetry.dependencies`. */
const TOML_TABLE_RE = /^\[{1,2}\s*([^\]]+?)\s*\]{1,2}$/;

/** Captures a TOML key that opens an array, and the rest of the line. */
const TOML_ARRAY_KEY_RE = /^["']?([\w.-]+)["']?\s*=\s*\[(.*)$/;

/** Captures a TOML key, as `flask` in `flask = "^3"`. */
const TOML_KEY_RE = /^["']?([\w.-]+)["']?\s*=/;

/** Poetry tables whose keys are package names. */
const POETRY_DEPENDENCY_TABLE_RE =
  /^tool\.poetry\.(?:group\.[^.]+\.)?(?:dev-)?dependencies$/;

/** Lowercased package name of a requirement string (PEP 508), or null. */
function requirementName(requirement: string): string | null {
  const name = REQUIREMENT_NAME_RE.exec(requirement)?.[1];
  return name ? name.toLowerCase().replace(/[-_.]+/g, "-") : null;
}

/** Package names that requirements.txt lists, skipping comments and options. */
function requirementsDependencies(contents: string): string[] {
  return contents
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter((line) => line && !line.startsWith("-"))
    .map(requirementName)
    .filter((name): name is string => name !== null);
}

/**
 * Whether a TOML array under `table.key` lists dependencies: PEP 621
 * `project.dependencies` and `project.optional-dependencies`, and PEP 735
 * `dependency-groups`.
 */
function isDependencyArray(table: string, key: string): boolean {
  return (
    (table === "project" && key === "dependencies") ||
    table === "project.optional-dependencies" ||
    table === "dependency-groups"
  );
}

/** Whether a TOML line closes an array, ignoring `]` in strings such as `"fastapi[standard]"`. */
function closesArray(line: string): boolean {
  return line.replace(TOML_STRING_RE, "").includes("]");
}

/**
 * Package names that pyproject.toml declares as dependencies, from PEP 621
 * and PEP 735 arrays and Poetry dependency tables. A line-based read, not a
 * TOML parser: it skips other keys such as `keywords = ["flask"]`.
 */
function pyprojectDependencies(contents: string): string[] {
  const names: string[] = [];
  const addStrings = (text: string) => {
    for (const [, value] of text.matchAll(TOML_STRING_RE)) {
      const name = requirementName(value ?? "");
      if (name) {
        names.push(name);
      }
    }
  };
  let table = "";
  let inArray = false;
  for (const raw of contents.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (inArray) {
      addStrings(line);
      inArray = !closesArray(line);
      continue;
    }
    const header = TOML_TABLE_RE.exec(line)?.[1];
    if (header) {
      table = header;
      continue;
    }
    if (POETRY_DEPENDENCY_TABLE_RE.test(table)) {
      const key = TOML_KEY_RE.exec(line)?.[1];
      const name = key ? requirementName(key) : null;
      if (name) {
        names.push(name);
      }
      continue;
    }
    const array = TOML_ARRAY_KEY_RE.exec(line);
    if (array?.[1] && isDependencyArray(table, array[1])) {
      const rest = array[2] ?? "";
      addStrings(rest);
      inArray = !closesArray(rest);
    }
  }
  return names;
}

/** Check for go.mod and return `go run .` */
async function tryGoMod(cwd: string): Promise<DetectedCommand | null> {
  // oxlint-disable-next-line sentry-cli/no-silent-catch -- grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    await access(join(cwd, "go.mod"));
    return { args: ["go", "run", "."], source: "go.mod" };
  } catch {
    return null;
  }
}

/** Check for docker-compose.yml or compose.yml. */
async function tryDockerCompose(cwd: string): Promise<DetectedCommand | null> {
  for (const filename of ["docker-compose.yml", "compose.yml"]) {
    // oxlint-disable-next-line sentry-cli/no-silent-catch -- grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    try {
      await access(join(cwd, filename));
      return { args: ["docker", "compose", "up"], source: filename };
    } catch {
      // File doesn't exist — try next
    }
  }
  return null;
}
