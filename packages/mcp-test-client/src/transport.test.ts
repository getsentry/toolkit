import { describe, expect, it } from "vitest";
import {
  buildStdioServerCommand,
  buildStdioServerLaunchConfig,
  resolveTransportMode,
} from "./transport.js";

describe("resolveTransportMode", () => {
  it("defaults to stdio when auto mode has an access token", () => {
    expect(
      resolveTransportMode({
        requestedTransport: "auto",
        accessToken: "token-123",
      }),
    ).toBe("stdio");
  });

  it("defaults to http when auto mode has no access token", () => {
    expect(
      resolveTransportMode({
        requestedTransport: "auto",
      }),
    ).toBe("http");
  });

  it("honors explicit stdio without an access token", () => {
    expect(
      resolveTransportMode({
        requestedTransport: "stdio",
      }),
    ).toBe("stdio");
  });
});

describe("buildStdioServerLaunchConfig", () => {
  it("omits token settings when no access token is provided", () => {
    const launchConfig = buildStdioServerLaunchConfig(
      {
        host: "sentry.io",
      },
      {
        PATH: "/usr/bin",
        HOME: "/tmp/home",
      },
    );

    expect(launchConfig.args).toEqual([]);
    expect(launchConfig.env).toEqual({
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      SENTRY_HOST: "sentry.io",
    });
  });

  it("includes token and optional flags when provided", () => {
    const launchConfig = buildStdioServerLaunchConfig(
      {
        accessToken: "token-123",
        host: "us.sentry.io",
        sentryDsn: "https://dsn.example/1",
        useExperimental: true,
      },
      {
        PATH: "/usr/bin",
        SENTRY_ACCESS_TOKEN: "stale-token",
        SENTRY_TOKEN: "other-token",
      },
    );

    expect(launchConfig.args).toEqual([
      "--sentry-dsn=https://dsn.example/1",
      "--experimental",
    ]);
    expect(launchConfig.env).toEqual({
      PATH: "/usr/bin",
      SENTRY_AUTH_TOKEN: "token-123",
      SENTRY_HOST: "us.sentry.io",
      SENTRY_DSN: "https://dsn.example/1",
    });
  });
});

describe("buildStdioServerCommand", () => {
  it("runs `sentry mcp` from CLI source by default", () => {
    expect(buildStdioServerCommand({}, "/repo/packages")).toEqual({
      command: "pnpm",
      args: ["--silent", "--dir", "/repo/packages/cli", "run", "cli", "mcp"],
    });
  });

  it("runs the built @sentry/mcp-server bundle with Node", () => {
    const bundlePath = "/repo/packages/mcp-server/dist/sentry-mcp.cjs";
    expect(
      buildStdioServerCommand({ useBundle: true }, "/repo/packages"),
    ).toEqual({
      command: process.execPath,
      args: [bundlePath],
      bundlePath,
    });
  });
});
