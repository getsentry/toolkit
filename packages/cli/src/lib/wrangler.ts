/**
 * Wrangler-specific command augmentation for Cloudflare Workers local dev.
 *
 * Process environment variables inherited by `wrangler dev` are not exposed
 * as Worker bindings. The Cloudflare Sentry SDK reads `SENTRY_SPOTLIGHT` from
 * the Worker `env` object, so `sentry local run` must pass it through
 * Wrangler's `--var` flag rather than relying on child-process inheritance.
 */

import { access, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { logger } from "./logger.js";

/** Wrangler project configuration filenames, in resolution order. */
const WRANGLER_CONFIG_FILES = [
  "wrangler.json",
  "wrangler.jsonc",
  "wrangler.toml",
] as const;

/** Package managers that can execute project scripts. */
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);

/** Global variant used to find each candidate in a shell command. */
const WRANGLER_DEV_SHELL_GLOBAL_RE =
  /\bwrangler(?:\.cmd)?\s+(?:pages\s+)?dev\b/gi;

/** Match a custom Wrangler config flag inside argv or a shell command. */
const WRANGLER_CONFIG_RE = /(?:^|\s)--config(?:=|\s+)\S+/;

/** Valid tokens before Wrangler within one shell command segment. */
const WRANGLER_COMMAND_PREFIX_RE =
  /^(?:[A-Za-z_]\w*=\S+\s+)*(?:(?:exec|npx|bunx|pnpm\s+(?:exec|dlx|x)|yarn\s+dlx)\s+)?(?:[^\s]*[\\/])?$/i;

/** Match an existing SENTRY_SPOTLIGHT Wrangler binding. */
const SPOTLIGHT_VAR_RE = /^SENTRY_SPOTLIGHT(?::|=)/;

/** Match an existing SENTRY_SPOTLIGHT binding inside a shell command. */
const SHELL_SPOTLIGHT_VAR_RE = /--var(?:=|\s+)["']?SENTRY_SPOTLIGHT(?::|=)/;

/** Strip Windows' executable suffix before command comparisons. */
const CMD_SUFFIX_RE = /\.cmd$/i;

/** Package-manager commands that do not identify a project script. */
const PACKAGE_MANAGER_NON_SCRIPT_COMMANDS = new Set([
  "add",
  "dlx",
  "exec",
  "install",
  "publish",
  "remove",
  "run",
  "uninstall",
  "x",
]);

/** Result of attempting to augment a command for Wrangler. */
export type WranglerCommandAugmentation = {
  /** Spawn arguments, possibly containing an injected `--var`. */
  args: string[];
  /** Whether the Worker binding was injected. */
  injected: boolean;
};

/** Return the executable's platform-independent basename. */
function executableName(value: string): string {
  return basename(value.replaceAll("\\", "/"))
    .replace(CMD_SUFFIX_RE, "")
    .toLowerCase();
}

/** Whether args already provide an explicit SENTRY_SPOTLIGHT Wrangler var. */
function hasSpotlightVar(args: readonly string[]): boolean {
  return args.some((arg, index) => {
    if (SHELL_SPOTLIGHT_VAR_RE.test(arg)) {
      return true;
    }
    if (arg.startsWith("--var=")) {
      return SPOTLIGHT_VAR_RE.test(arg.slice("--var=".length));
    }
    return args[index - 1] === "--var" && SPOTLIGHT_VAR_RE.test(arg);
  });
}

/**
 * Find where the Wrangler command ends inside a shell script.
 *
 * Shell control operators and redirections delimit the command, but operators
 * inside quotes or command substitutions do not. The returned offset is where
 * Wrangler's `--var` must be inserted.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this is a single-pass shell lexer; splitting its quote/escape/substitution state would obscure the transitions
function findShellCommandEnd(script: string, start: number): number {
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;
  let substitutionDepth = 0;

  for (let index = start; index < script.length; index += 1) {
    const char = script[index];
    const next = script[index + 1];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "$" && next === "(") {
      substitutionDepth += 1;
      index += 1;
      continue;
    }
    if (char === ")" && substitutionDepth > 0) {
      substitutionDepth -= 1;
      continue;
    }
    if (substitutionDepth > 0) {
      continue;
    }
    if (
      char === "\n" ||
      char === ";" ||
      char === "&" ||
      char === "|" ||
      char === "<" ||
      char === ">" ||
      char === "#"
    ) {
      return index;
    }
  }
  return script.length;
}

/**
 * Find the start of the shell command segment containing `position`.
 *
 * Returns undefined when the position is inside a quote or command
 * substitution, which means a textual `wrangler dev` is not executable code.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: same single-pass shell lexer as findShellCommandEnd, walking in the opposite direction conceptually
function findShellSegmentStart(
  script: string,
  position: number
): number | undefined {
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;
  let substitutionDepth = 0;
  let segmentStart = 0;

  for (let index = 0; index < position; index += 1) {
    const char = script[index];
    const next = script[index + 1];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "$" && next === "(") {
      substitutionDepth += 1;
      index += 1;
      continue;
    }
    if (char === ")" && substitutionDepth > 0) {
      substitutionDepth -= 1;
      continue;
    }
    if (
      substitutionDepth === 0 &&
      (char === "\n" || char === ";" || char === "&" || char === "|")
    ) {
      segmentStart = index + 1;
    }
  }

  return quote || substitutionDepth > 0 ? undefined : segmentStart;
}

/** Quote one argument for a POSIX shell command string. */
function posixShellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Quote one argument for a Windows cmd.exe command string. */
function windowsShellQuote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** Location of an executable `wrangler dev` within a shell script. */
type ShellWranglerCommand = {
  end: number;
};

/** Find an executable Wrangler command, excluding quoted text and arguments. */
function findShellWranglerCommand(
  script: string
): ShellWranglerCommand | undefined {
  for (const match of script.matchAll(WRANGLER_DEV_SHELL_GLOBAL_RE)) {
    const matchIndex = match.index;
    const segmentStart = findShellSegmentStart(script, matchIndex);
    if (segmentStart === undefined) {
      continue;
    }
    const prefix = script.slice(segmentStart, matchIndex);
    if (!WRANGLER_COMMAND_PREFIX_RE.test(prefix)) {
      continue;
    }
    return {
      end: findShellCommandEnd(script, matchIndex + match[0].length),
    };
  }
  return;
}

/** Add the binding to an executable Wrangler command inside a shell script. */
function injectIntoShellCommand(
  script: string,
  binding: string,
  windows = false
): string | undefined {
  const command = findShellWranglerCommand(script);
  if (!command) {
    return;
  }
  const before = script.slice(0, command.end).trimEnd();
  const spacing = script.slice(before.length, command.end);
  const quotedBinding = windows
    ? windowsShellQuote(binding)
    : posixShellQuote(binding);
  return `${before} --var ${quotedBinding}${spacing}${script.slice(command.end)}`;
}

/** Find Wrangler only in supported executable/wrapper argv positions. */
function directWranglerIndex(args: readonly string[]): number {
  if (executableName(args[0] ?? "") === "wrangler") {
    return 0;
  }

  const executable = executableName(args[0] ?? "");
  if (executable === "npx" || executable === "bunx") {
    return args.findIndex(
      (arg, index) => index > 0 && executableName(arg) === "wrangler"
    );
  }
  if (PACKAGE_MANAGERS.has(executable)) {
    const wrapperIndex = args.findIndex((arg) =>
      ["dlx", "exec", "x"].includes(arg)
    );
    if (wrapperIndex !== -1) {
      return args.findIndex(
        (arg, index) =>
          index > wrapperIndex && executableName(arg) === "wrangler"
      );
    }
  }

  return -1;
}

/** Whether a direct/wrapped command invokes `wrangler dev`. */
function isDirectWranglerDev(args: readonly string[]): boolean {
  const wranglerIndex = directWranglerIndex(args);
  if (wranglerIndex === -1) {
    return false;
  }
  const following = args.slice(wranglerIndex + 1);
  return (
    following[0] === "dev" ||
    (following[0] === "pages" && following[1] === "dev")
  );
}

/** A package-manager script invocation and its forwarding behavior. */
type PackageScriptInvocation = {
  manager: string;
  name: string;
};

/** Return the first non-option token at or after `start`. */
function firstNonOption(
  args: readonly string[],
  start: number
): string | undefined {
  return args.slice(start).find((arg) => !arg.startsWith("-"));
}

/** Extract package-script metadata from standard and shorthand invocations. */
function packageScriptInvocation(
  args: readonly string[]
): PackageScriptInvocation | undefined {
  const manager = executableName(args[0] ?? "");
  if (!PACKAGE_MANAGERS.has(manager)) {
    return;
  }

  const runIndex = args.indexOf("run");
  if (runIndex !== -1) {
    const name = firstNonOption(args, runIndex + 1);
    return name ? { manager, name } : undefined;
  }

  const shorthand = firstNonOption(args, 1);
  if (
    shorthand &&
    (manager === "npm" ||
      !PACKAGE_MANAGER_NON_SCRIPT_COMMANDS.has(shorthand)) &&
    (manager !== "npm" ||
      ["start", "stop", "test", "restart"].includes(shorthand))
  ) {
    return { manager, name: shorthand };
  }
  return;
}

/** Read a package script without failing command startup on malformed files. */
async function readPackageScript(
  cwd: string,
  name: string
): Promise<string | undefined> {
  try {
    const raw = await readFile(join(cwd, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    const value = pkg.scripts?.[name];
    return typeof value === "string" ? value : undefined;
  } catch (error) {
    logger.debug("Could not inspect package script for Wrangler", error);
    return;
  }
}

/** Whether the project has a Wrangler config or the command names one. */
async function hasWranglerConfig(
  cwd: string,
  args: readonly string[]
): Promise<boolean> {
  if (
    args.some(
      (arg, index) => arg === "--config" && typeof args[index + 1] === "string"
    ) ||
    args.some(
      (arg) => arg.startsWith("--config=") || WRANGLER_CONFIG_RE.test(arg)
    )
  ) {
    return true;
  }

  for (const filename of WRANGLER_CONFIG_FILES) {
    // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    try {
      await access(join(cwd, filename));
      return true;
    } catch {
      // Try the next supported Wrangler filename.
    }
  }
  return false;
}

/** Try to inject into a shell string carried by `sh -c` or `cmd /c`. */
function injectIntoShellArgs(
  args: readonly string[],
  binding: string
): WranglerCommandAugmentation | undefined {
  for (let index = 1; index < args.length; index += 1) {
    const shellSwitch = args[index - 1]?.toLowerCase();
    if (shellSwitch !== "-c" && shellSwitch !== "/c") {
      continue;
    }
    const shellExecutable = executableName(args[index - 2] ?? "");
    const injected = injectIntoShellCommand(
      args[index] ?? "",
      binding,
      shellExecutable === "cmd" || shellExecutable === "cmd.exe"
    );
    if (injected) {
      const augmented = [...args];
      augmented[index] = injected;
      return { args: augmented, injected: true };
    }
  }
  return;
}

/** Build package-manager forwarding args without changing user script files. */
function injectIntoPackageScript(
  args: readonly string[],
  binding: string,
  invocation: PackageScriptInvocation,
  script: string
): WranglerCommandAugmentation {
  const unchanged = { args: [...args], injected: false };
  const packageWrangler = findShellWranglerCommand(script);
  if (!packageWrangler || SHELL_SPOTLIGHT_VAR_RE.test(script)) {
    return unchanged;
  }
  if (script.slice(packageWrangler.end).trim()) {
    logger.warn(
      `Could not inject SENTRY_SPOTLIGHT into compound package script "${invocation.name}"; run sentry local run without an explicit command to use auto-detection`
    );
    return unchanged;
  }

  if (invocation.manager === "npm") {
    const separator = args.includes("--") ? [] : ["--"];
    return {
      args: [...args, ...separator, "--var", binding],
      injected: true,
    };
  }

  const separatorIndex = args.indexOf("--");
  if (separatorIndex !== -1) {
    return {
      args: [
        ...args.slice(0, separatorIndex),
        "--var",
        binding,
        ...args.slice(separatorIndex),
      ],
      injected: true,
    };
  }

  return { args: [...args, "--var", binding], injected: true };
}

/**
 * Inject `SENTRY_SPOTLIGHT` as a Wrangler Worker binding when appropriate.
 *
 * Supports direct invocations (`wrangler dev`, `npx wrangler dev`),
 * auto-detected shell scripts, and explicit package-manager scripts such as
 * `npm run dev`. User-supplied `--var SENTRY_SPOTLIGHT:...` always wins.
 *
 * @param args - Child command arguments
 * @param spotlightUrl - Local envelope endpoint
 * @param cwd - Project root used to find Wrangler/package configuration
 */
export async function injectWranglerSpotlightBinding(
  args: readonly string[],
  spotlightUrl: string,
  cwd: string
): Promise<WranglerCommandAugmentation> {
  const unchanged = { args: [...args], injected: false };
  const packageInvocation = packageScriptInvocation(args);
  const packageScript = packageInvocation
    ? await readPackageScript(cwd, packageInvocation.name)
    : undefined;
  const configInputs = packageScript ? [...args, packageScript] : args;

  if (!(await hasWranglerConfig(cwd, configInputs)) || hasSpotlightVar(args)) {
    return unchanged;
  }

  const binding = `SENTRY_SPOTLIGHT:${spotlightUrl}`;
  if (isDirectWranglerDev(args)) {
    return { args: [...args, "--var", binding], injected: true };
  }

  const shellResult = injectIntoShellArgs(args, binding);
  if (shellResult) {
    return shellResult;
  }

  if (!(packageInvocation && packageScript)) {
    return unchanged;
  }
  return injectIntoPackageScript(
    args,
    binding,
    packageInvocation,
    packageScript
  );
}
