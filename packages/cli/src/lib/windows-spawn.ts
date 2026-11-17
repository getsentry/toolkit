/**
 * Spawn a user-supplied command the way a Windows shell would find it.
 *
 * `spawn()` does not apply PATHEXT, so `npm` is not found (ENOENT), and since
 * the CVE-2024-27980 fix Node refuses to run a `.cmd` or `.bat` file without a
 * shell (EINVAL). Turning on `shell: true` would join the arguments without
 * quoting them, so this module resolves the command itself and runs batch
 * files through `cmd.exe` with each argument escaped, like `cross-spawn`.
 *
 * `whichSync` does not fit here: `where.exe npm` lists the extensionless sh
 * script that npm installs before `npm.cmd`, and Windows cannot run it.
 */

import { statSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";

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

/** Batch files, which only `cmd.exe` can run. */
const BATCH_FILE_RE = /\.(?:cmd|bat)$/i;

/**
 * An npm `.cmd` shim in `node_modules/.bin` passes its arguments through a
 * second `cmd.exe` parse, so shell metacharacters need escaping twice.
 */
const CMD_SHIM_RE = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;

/** Characters `cmd.exe` treats specially; escaped with `^`. */
const CMD_META_RE = /([()\][%!^"`<>&|;, *?])/g;

/** Backslashes followed by a double quote. */
const QUOTE_BACKSLASHES_RE = /(\\*)"/g;

/** Backslashes at the end of the string. */
const TRAILING_BACKSLASHES_RE = /(\\*)$/;

/** A command given as a path, not a bare name to look up on PATH. */
const HAS_PATH_SEPARATOR_RE = /[\\/]/;

/** Read an environment variable by name, ignoring case like Windows does. */
function getEnv(env: SpawnEnv, name: string): string | undefined {
  const key = Object.keys(env).find(
    (k) => k.toUpperCase() === name.toUpperCase(),
  );
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
    : (getEnv(env, "PATH") ?? "").split(";").filter(Boolean);

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

/** Escape a program path for a `cmd.exe` command line. */
function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META_RE, "^$1");
}

/**
 * Quote one argument for a `cmd.exe` command line: first for the program's
 * own argument parser (MSVCRT rules), then `^`-escape the result for
 * `cmd.exe`.
 */
function escapeCmdArgument(arg: string, doubleEscape: boolean): string {
  let quoted = arg
    .replace(QUOTE_BACKSLASHES_RE, '$1$1\\"')
    .replace(TRAILING_BACKSLASHES_RE, "$1$1");
  quoted = `"${quoted}"`.replace(CMD_META_RE, "^$1");
  return doubleEscape ? quoted.replace(CMD_META_RE, "^$1") : quoted;
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
  if (!BATCH_FILE_RE.test(resolved)) {
    return { command: resolved, args };
  }
  const doubleEscape = CMD_SHIM_RE.test(resolved);
  const commandLine = [
    escapeCmdCommand(resolved),
    ...args.map((arg) => escapeCmdArgument(arg, doubleEscape)),
  ].join(" ");
  return {
    command: getEnv(options.env, "ComSpec") ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}
