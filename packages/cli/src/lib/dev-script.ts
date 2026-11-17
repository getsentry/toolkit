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
 * 3. FLASK_APP env var (Flask)
 * 4. app.py, then main.py (FastAPI, Flask, or a plain Python script)
 * 5. wsgi.py (Flask only)
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
    tryFlaskAppEnv(env, python) ??
    (await tryPythonApp(cwd, "app.py", python, true)) ??
    (await tryPythonApp(cwd, "main.py", python, true)) ??
    (await tryPythonApp(cwd, "wsgi.py", python, false)) ??
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

/** With `FLASK_APP` set, let `flask run` load the app it names. */
function tryFlaskAppEnv(
  env: Record<string, string | undefined>,
  python: PythonLookup,
): DetectedCommand | null {
  if (!env.FLASK_APP) {
    return null;
  }
  return {
    args: [python(), "-m", "flask", "run"],
    source: "FLASK_APP (Flask)",
  };
}

/** Matches `if __name__ == "__main__":`, a file that starts its own server. */
const MAIN_GUARD_RE = /^if\s+__name__\s*==\s*["']__main__["']\s*:/m;

/** Captures the variable a FastAPI app is assigned to, as in `api = FastAPI()`. */
const FASTAPI_APP_RE = /^(\w+)\s*(?::[^=\n]+)?=\s*(?:\w+\.)?FastAPI\(/m;

/**
 * Detect a Python web app in `filename`.
 *
 * A file with a `__main__` guard starts its own server, so it always runs as
 * `python <file>`. Otherwise a FastAPI or Flask app has no code that serves
 * it, and `python <file>` would exit right away, so its server runs it:
 * uvicorn for FastAPI, `flask run` for Flask. Uvicorn rather than
 * `fastapi dev`, because plain `fastapi` installs a `fastapi` script that
 * fails without `fastapi[standard]`, and any venv that has fastapi-cli has
 * uvicorn too. The app in the file decides the framework before the
 * declared dependencies do. A file with no app and no guard runs as a script
 * only when `runAsScript` is set.
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
  const module = filename.slice(0, -".py".length);
  const fastapiApp = FASTAPI_APP_RE.exec(source)?.[1];
  const framework = fastapiApp
    ? "FastAPI"
    : source.includes("Flask(")
      ? "Flask"
      : await declaredFramework(cwd);
  if (framework === "FastAPI") {
    return {
      args: [
        python(),
        "-m",
        "uvicorn",
        `${module}:${fastapiApp ?? "app"}`,
        "--reload",
      ],
      source: `${filename} (FastAPI)`,
    };
  }
  if (framework === "Flask") {
    return {
      args: [python(), "-m", "flask", "--app", module, "run"],
      source: `${filename} (Flask)`,
    };
  }
  return runAsScript ? script : null;
}

/** Python dependency manifests checked for a framework. */
const DEPENDENCY_FILES = ["pyproject.toml", "requirements.txt"] as const;

/**
 * Matches a requirement for the package named by the group: at the start of
 * a line (requirements.txt, Poetry keys) or of a quoted string (PEP 621
 * lists), then a version, extra, marker, comment, or the end. So
 * `fastapi-users`, comments, and prose such as `"A flask demo"` do not count.
 */
const REQUIREMENT_RE = /(?:^\s*|["'])(fastapi|flask)\s*(?:[[<>=~!;@#"']|$)/im;

/** The web framework that pyproject.toml or requirements.txt declares. */
async function declaredFramework(
  cwd: string,
): Promise<"FastAPI" | "Flask" | null> {
  for (const file of DEPENDENCY_FILES) {
    const contents = await readFile(join(cwd, file), "utf-8").catch(() => null);
    const name =
      contents === null ? undefined : REQUIREMENT_RE.exec(contents)?.[1];
    if (name) {
      return name.toLowerCase() === "fastapi" ? "FastAPI" : "Flask";
    }
  }
  return null;
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
