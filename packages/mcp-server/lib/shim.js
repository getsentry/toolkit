/**
 * Deprecation shim for `@sentry/mcp-server`.
 *
 * The stdio MCP server now ships in the Sentry CLI as `sentry mcp`. This
 * package forwards every invocation to the `sentry` package so existing MCP
 * client configurations keep working for one last release.
 *
 * To delete after the final `@sentry/mcp-server` publish.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { constants } from "node:os";
import { dirname, join } from "node:path";

export const DEPRECATION_NOTICE =
  "@sentry/mcp-server is deprecated and now runs `sentry mcp`; update your MCP client to run `npx -y sentry mcp`.";

/**
 * Map `@sentry/mcp-server` arguments to `sentry` arguments.
 *
 * Server flags pass through to `sentry mcp` unchanged. The old `auth`
 * subcommands map to the CLI's own `sentry auth` commands; bare `auth` meant
 * `auth login`.
 *
 * @param {readonly string[]} args
 * @returns {string[]}
 */
export function toSentryArgs(args) {
  if (args[0] !== "auth") {
    return ["mcp", ...args];
  }
  const rest = args.slice(1);
  return ["auth", ...(rest.length > 0 ? rest : ["login"])];
}

/**
 * Locate the `sentry` package's bin script next to its main entry.
 *
 * @param {(id: string) => string} [resolve]
 * @returns {string}
 */
export function resolveSentryBin(
  resolve = createRequire(import.meta.url).resolve,
) {
  return join(dirname(resolve("sentry")), "bin.cjs");
}

/**
 * Run `sentry` with the mapped arguments and mirror its exit status.
 *
 * @param {readonly string[]} args
 */
export function run(args) {
  process.stderr.write(`${DEPRECATION_NOTICE}\n`);

  const child = spawn(
    process.execPath,
    [resolveSentryBin(), ...toSentryArgs(args)],
    {
      stdio: "inherit",
    },
  );
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => {
    process.stderr.write(`Failed to start sentry: ${error.message}\n`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    process.exit(code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0));
  });
}
