import { join } from "node:path";
import type { MCPConfig, RequestedTransportMode } from "./types.js";

export function resolveTransportMode(options: {
  requestedTransport?: RequestedTransportMode;
  accessToken?: string;
}): "stdio" | "http" {
  const requestedTransport = options.requestedTransport || "auto";

  if (requestedTransport === "auto") {
    return options.accessToken ? "stdio" : "http";
  }

  return requestedTransport;
}

export function buildStdioServerLaunchConfig(
  config: MCPConfig,
  baseEnv: NodeJS.ProcessEnv = process.env,
): {
  args: string[];
  env: Record<string, string>;
} {
  // The host goes through SENTRY_HOST below; the server's --host is deprecated.
  const args: string[] = [];

  if (config.sentryDsn) {
    args.push(`--sentry-dsn=${config.sentryDsn}`);
  }
  if (config.useExperimental) {
    args.push("--experimental");
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }

  // The server's own env token, which it uses over any stored CLI login. Never on
  // argv, where other processes can read it, and never through the deprecated
  // SENTRY_ACCESS_TOKEN alias the server would warn about.
  delete env.SENTRY_ACCESS_TOKEN;
  if (config.accessToken) {
    delete env.SENTRY_TOKEN;
    env.SENTRY_AUTH_TOKEN = config.accessToken;
  }
  if (config.host) {
    env.SENTRY_HOST = config.host;
  }
  if (config.sentryDsn) {
    env.SENTRY_DSN = config.sentryDsn;
  }

  return { args, env };
}

/**
 * The process that serves stdio: `sentry mcp` from the workspace CLI source,
 * or the built `@sentry/mcp-server` bundle, which is what the package ships.
 */
export function buildStdioServerCommand(
  config: Pick<MCPConfig, "useBundle">,
  packagesDir: string,
): { command: string; args: string[]; bundlePath?: string } {
  if (config.useBundle) {
    const bundlePath = join(packagesDir, "mcp-server/dist/sentry-mcp.cjs");
    return { command: process.execPath, args: [bundlePath], bundlePath };
  }
  return {
    command: "pnpm",
    args: ["--silent", "--dir", join(packagesDir, "cli"), "run", "cli", "mcp"],
  };
}
