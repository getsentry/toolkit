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
 * `command` as the running program spells it: a leading `sentry ` (how
 * command docs write their examples) becomes this program's name.
 */
export function asRunningAppCommand(command: string): string {
  return command.startsWith("sentry ")
    ? `${identity.name}${command.slice("sentry".length)}`
    : command;
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

/** Command that signs in to the active Sentry host. */
export function getLoginCommand(): string {
  return `${getInvocationCommand()} auth login`;
}

/** Command that signs in and confirms a self-hosted host (append the URL). */
export function getUrlLoginCommand(): string {
  return `${getLoginCommand()} --url`;
}
