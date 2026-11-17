/**
 * Which program is running, so hints name a command the user can run.
 *
 * The same code ships as the `sentry` CLI and as the `@sentry/mcp-server`
 * package (`sentry-mcp`). Each entry point registers its identity before it
 * starts; library code reads it here instead of assuming `sentry`.
 */

import { getEnv } from "./env.js";

export type AppIdentity = {
  /** The binary name, as installed on PATH. */
  readonly name: string;
  /** The npm package that ships the binary. */
  readonly packageName: string;
};

let identity: AppIdentity = { name: "sentry", packageName: "sentry" };

/** Register the running program. Called by entry points before startup. */
export function setAppIdentity(next: AppIdentity): void {
  identity = next;
}

/** The running program; the `sentry` CLI unless an entry point said otherwise. */
export function getAppIdentity(): AppIdentity {
  return identity;
}

/**
 * Whether npm's `npx` (`npm exec`) launched this process. The binary is then
 * not on PATH, so hints must go through `npx` too.
 */
function launchedThroughNpx(): boolean {
  return (
    getEnv().npm_command === "exec" ||
    /[\\/]_npx[\\/]/.test(process.argv[1] ?? "")
  );
}

/**
 * The command that runs this program again: the binary name, or
 * `npx -y <package>` when `npx` launched it.
 */
export function getInvocationCommand(): string {
  return launchedThroughNpx()
    ? `npx -y ${identity.packageName}`
    : identity.name;
}

/**
 * Tag for a hint that runs this program again, written without the program
 * name: `` sentry`issue list ${org}/` `` gives `sentry issue list acme/`,
 * `npx -y sentry issue list acme/`, or `sentry-mcp issue list acme/`.
 *
 * Interpolated values are inserted as they are. A command built with this
 * tag already names the program, so nesting one never names it twice, and
 * text that only looks like a command is never rewritten.
 *
 * The program is known only once an entry point has started, so build the
 * hint where it is shown. A command kept in a constant or a table is a
 * {@link LazyCommand}: `` const usageHint = () => sentry`issue view <id>` ``.
 */
export function sentry(
  strings: TemplateStringsArray,
  ...values: unknown[]
): string {
  const text = strings.reduce(
    (built, part, i) => `${built}${String(values[i - 1])}${part}`,
  );
  return `${getInvocationCommand()} ${text}`;
}

/** A command hint built when it is shown, as `() => sentry`issue view <id>``. */
export type LazyCommand = () => string;

/** Command that signs in to the active Sentry host. */
export function getLoginCommand(): string {
  return `${getInvocationCommand()} auth login`;
}

/** Command that signs in and confirms a self-hosted host (append the URL). */
export function getUrlLoginCommand(): string {
  return `${getLoginCommand()} --url`;
}
