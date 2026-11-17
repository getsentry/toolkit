/**
 * Spawn a user-supplied command the way a Windows shell would find it.
 *
 * `spawn()` does not apply PATHEXT, so `npm` is not found (ENOENT), and since
 * the CVE-2024-27980 fix Node refuses to run a `.cmd` or `.bat` file without a
 * shell (EINVAL). Turning on `shell: true` would join the arguments without
 * quoting them, so this module resolves the command itself and runs anything
 * that is not an `.exe` or `.com` through `cmd.exe`, quoting each argument
 * the way Rust's standard library does since CVE-2024-24576 ("BatBadBut").
 *
 * `whichSync` does not fit here: `where.exe npm` lists the extensionless sh
 * script that npm installs before `npm.cmd`, and Windows cannot run it.
 */

import {
  type ChildProcess,
  type SpawnOptions,
  spawn,
} from "node:child_process";
import { statSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import { COMMAND_LINE_BREAK_FIELD, ValidationError } from "./errors.js";

/** What to pass to `spawn()`. */
export type SpawnTarget = {
  command: string;
  args: string[];
  /** Set for `cmd.exe`: the arguments are already quoted. */
  windowsVerbatimArguments?: boolean;
};

type SpawnEnv = Record<string, string | undefined>;

/** Used when PATHEXT is unset; the Windows default order. */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/** Files Windows can run directly; anything else goes through `cmd.exe`. */
const EXECUTABLE_RE = /\.(?:com|exe)$/i;

/** A command given as a path, not a bare name to look up on PATH. */
const HAS_PATH_SEPARATOR_RE = /[\\/]/;

/** A PATH entry wrapped in double quotes, which Windows allows. */
const QUOTED_PATH_ENTRY_RE = /^"(.*)"$/;

/** Line breaks end a `cmd.exe` command, so they cannot be passed safely. */
const LINE_BREAK_RE = /[\r\n]/;

/**
 * Expands to nothing in `cmd.exe`, so `%` followed by it is never read as the
 * start of a `%VAR%` reference (needs command extensions, `/e:ON`).
 */
const PERCENT_GUARD = "%cd:~,";

/**
 * The key Node passes to the child for an environment variable on Windows.
 *
 * Windows names are case-insensitive, and a copy of `process.env` can hold
 * both `Path` and `PATH`. Node keeps only the key that sorts first, so this
 * returns the same one.
 */
export function windowsEnvKey(env: SpawnEnv, name: string): string | undefined {
  const upper = name.toUpperCase();
  return Object.keys(env)
    .sort()
    .find((key) => key.toUpperCase() === upper);
}

/** Read an environment variable the way the Windows child will see it. */
function getEnv(env: SpawnEnv, name: string): string | undefined {
  const key = windowsEnvKey(env, name);
  return key === undefined ? undefined : env[key];
}

/** Whether a regular file exists at `path`. */
function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

/**
 * Find the file Windows would run for `command`: a bare name is searched on
 * PATH, a path is taken relative to `cwd`. Without a PATHEXT extension, each
 * PATHEXT extension is tried in order.
 */
function resolveWindowsCommand(
  command: string,
  cwd: string,
  env: SpawnEnv,
): string | undefined {
  const extensions = (getEnv(env, "PATHEXT") ?? DEFAULT_PATHEXT)
    .split(";")
    .filter(Boolean);
  const hasExtension = extensions.some(
    (ext) => ext.toUpperCase() === extname(command).toUpperCase(),
  );
  const names = hasExtension
    ? [command]
    : extensions.map((ext) => command + ext.toLowerCase());

  const dirs = HAS_PATH_SEPARATOR_RE.test(command)
    ? [isAbsolute(command) ? "" : cwd]
    : (getEnv(env, "PATH") ?? "")
        .split(";")
        .map((dir) => dir.replace(QUOTED_PATH_ENTRY_RE, "$1"))
        .filter(Boolean);

  for (const dir of dirs) {
    for (const name of names) {
      const candidate = dir ? resolve(cwd, join(dir, name)) : name;
      if (isFile(candidate)) {
        return candidate;
      }
    }
  }
  return;
}

/** Keep `cmd.exe` from expanding `%VAR%` in `text`; see {@link PERCENT_GUARD}. */
function guardPercent(text: string): string {
  return text.replaceAll("%", `%${PERCENT_GUARD}%`);
}

/**
 * Quote one argument for a batch file run by `cmd.exe`.
 *
 * Every argument is quoted, so `cmd.exe` treats `&`, `|`, `<`, `>`, `^` and
 * spaces as text, both on this command line and when the batch file expands
 * `%*`. An embedded `"` is written as `""`, which keeps `cmd.exe` inside the
 * quotes and which the program reads back as one `"`. Backslashes before a
 * `"` are doubled for the program's own parser (MSVCRT rules), and `%` gets
 * {@link PERCENT_GUARD} so `%PATH%` is not expanded.
 */
function quoteBatchArgument(arg: string): string {
  if (LINE_BREAK_RE.test(arg)) {
    throw new ValidationError(
      "Arguments to a .cmd or .bat command cannot contain line breaks.",
      COMMAND_LINE_BREAK_FIELD,
    );
  }
  let quoted = '"';
  let backslashes = 0;
  for (const char of arg) {
    if (char === "\\") {
      backslashes += 1;
      quoted += char;
      continue;
    }
    if (char === '"') {
      quoted += `${"\\".repeat(backslashes)}"`;
    }
    backslashes = 0;
    quoted += char;
  }
  return guardPercent(`${quoted}${"\\".repeat(backslashes)}"`);
}

/**
 * Work out how to spawn `command` with `args` so that it runs on Windows the
 * way it would from a terminal. On other platforms it is returned unchanged.
 *
 * When the command cannot be found it is also returned unchanged, so `spawn()`
 * reports ENOENT as usual.
 *
 * @param command - The executable the user asked to run, e.g. `npm`
 * @param args - Its arguments
 * @param options - The `cwd` and `env` the child will get (PATH may differ
 *   from this process's)
 * @param platform - Defaults to `process.platform`; tests set it
 * @throws {ValidationError} When a batch file would get an argument with a
 *   line break
 */
export function resolveSpawnTarget(
  command: string,
  args: string[],
  options: { cwd: string; env: SpawnEnv },
  platform: NodeJS.Platform = process.platform,
): SpawnTarget {
  if (platform !== "win32") {
    return { command, args };
  }
  const resolved = resolveWindowsCommand(command, options.cwd, options.env);
  if (!resolved) {
    return { command, args };
  }
  if (EXECUTABLE_RE.test(resolved)) {
    return { command: resolved, args };
  }
  // Windows file names cannot contain `"`, but they can contain `%`.
  const commandLine = [
    `"${guardPercent(resolved)}"`,
    ...args.map(quoteBatchArgument),
  ].join(" ");
  return {
    command: getEnv(options.env, "ComSpec") ?? "cmd.exe",
    args: ["/d", "/e:ON", "/v:OFF", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * Spawn the command a user asked `sentry local run` or `sentry monitor run`
 * to run, resolved with {@link resolveSpawnTarget}.
 *
 * @param options - Passed to `spawn()`, plus `resolveCwd`: the directory a
 *   relative command path is resolved against. It is separate from `cwd`, so
 *   a caller can resolve without making the child start in that directory.
 * @throws {ValidationError} When a batch file would get an argument with a
 *   line break
 */
export function spawnUserCommand(
  command: string,
  args: string[],
  {
    resolveCwd,
    ...options
  }: SpawnOptions & { env: SpawnEnv; resolveCwd: string },
): ChildProcess {
  const target = resolveSpawnTarget(command, args, {
    cwd: resolveCwd,
    env: options.env,
  });
  return spawn(target.command, target.args, {
    ...options,
    windowsVerbatimArguments: target.windowsVerbatimArguments,
  });
}
