import { ALL_SKILLS } from "@sentry/mcp-core/skills";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { routes } from "../../src/app.js";
import { type CliEntry, isMcpInvocation, runCli } from "../../src/cli.js";
import { MCP_SKILL_NAMES } from "../../src/commands/mcp.js";
import { ValidationError } from "../../src/lib/errors.js";
import { routes as mcpServerRoutes } from "../../src/mcp-server-app.js";
import { SENTRY_CLI } from "../../src/sentry-cli.js";
import { useTestConfigDir } from "../helpers.js";

const mocks = vi.hoisted(() => ({
  serveMcp: vi.fn(),
  withTelemetry: vi.fn(),
  scheduleForceExit: vi.fn(),
  closeGlobalDispatcher: vi.fn(),
}));

vi.mock("../../src/lib/mcp.js", () => ({
  serveMcp: (...args: unknown[]) => mocks.serveMcp(...args),
}));
vi.mock("../../src/lib/telemetry.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/telemetry.js")>();
  return {
    ...actual,
    withTelemetry: (...args: Parameters<typeof actual.withTelemetry>) => {
      mocks.withTelemetry();
      return actual.withTelemetry(...args);
    },
  };
});
vi.mock("../../src/lib/force-exit.js", () => ({
  scheduleForceExit: () => mocks.scheduleForceExit(),
}));
vi.mock("../../src/lib/close-dispatcher.js", () => ({
  closeGlobalDispatcher: () => mocks.closeGlobalDispatcher(),
}));

useTestConfigDir("mcp-command-");

const MCP_SERVER: CliEntry = {
  loadApp: () => import("../../src/mcp-server-app.js"),
};

const originalExitCode = process.exitCode;
let stdout: string;
let stderr: string;

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.serveMcp.mockResolvedValue(undefined);
  mocks.closeGlobalDispatcher.mockResolvedValue(undefined);
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
});

describe("isMcpInvocation", () => {
  test("finds `mcp` after leading global flags in the CLI", () => {
    expect(isMcpInvocation(routes, ["mcp"])).toBe(true);
    expect(
      isMcpInvocation(routes, [
        "--verbose",
        "mcp",
        "--host=sentry.example.com",
      ]),
    ).toBe(true);
    expect(isMcpInvocation(routes, ["--org", "acme", "mcp"])).toBe(true);
    expect(isMcpInvocation(routes, ["issue", "mcp"])).toBe(false);
    expect(isMcpInvocation(routes, [])).toBe(false);
  });

  test("treats a bare invocation as `mcp` where it is the default", () => {
    expect(isMcpInvocation(mcpServerRoutes, [])).toBe(true);
    expect(
      isMcpInvocation(mcpServerRoutes, [
        "--access-token",
        "tok",
        "--all-skills",
      ]),
    ).toBe(true);
    expect(isMcpInvocation(mcpServerRoutes, ["auth", "status"])).toBe(false);
    expect(isMcpInvocation(mcpServerRoutes, ["help"])).toBe(false);
  });
});

describe("@sentry/mcp-server application", () => {
  test("has only mcp, auth, and help, with mcp as the default", () => {
    expect(
      mcpServerRoutes.getAllEntries().map((entry) => entry.name.original),
    ).toEqual(["mcp", "auth", "help"]);
    expect(mcpServerRoutes.getDefaultCommand()).toBe(
      mcpServerRoutes.getRoutingTargetForInput("mcp"),
    );
  });

  test("starts the server without a command", async () => {
    await runCli(["--host=sentry.example.com", "--all-skills"], MCP_SERVER);

    expect(mocks.serveMcp).toHaveBeenCalledOnce();
    expect(mocks.serveMcp.mock.lastCall?.[0]).toMatchObject({
      host: "sentry.example.com",
      "all-skills": true,
    });
  });
});

describe("running `mcp`", () => {
  test("serves through Stricli, without the CLI's telemetry", async () => {
    await runCli(["mcp", "--access-token=tok"], SENTRY_CLI);

    expect(mocks.serveMcp).toHaveBeenCalledOnce();
    expect(mocks.serveMcp.mock.lastCall?.[0]).toMatchObject({
      "access-token": "tok",
    });
    expect(mocks.withTelemetry).not.toHaveBeenCalled();
  });

  test("releases the network only after the server returns", async () => {
    let finishServing = () => undefined as void;
    mocks.serveMcp.mockReturnValue(
      new Promise<void>((resolve) => {
        finishServing = resolve;
      }),
    );

    const running = runCli(["mcp"], SENTRY_CLI);
    await vi.waitFor(() => expect(mocks.serveMcp).toHaveBeenCalledOnce());
    // A live stdio server must not be force-exited or lose its dispatcher.
    expect(mocks.scheduleForceExit).not.toHaveBeenCalled();
    expect(mocks.closeGlobalDispatcher).not.toHaveBeenCalled();

    finishServing();
    await running;
    expect(mocks.scheduleForceExit).toHaveBeenCalledOnce();
    expect(mocks.closeGlobalDispatcher).toHaveBeenCalledOnce();
  });

  test("reports a setup failure and cleans up", async () => {
    mocks.serveMcp.mockRejectedValue(new ValidationError("bad --skills"));

    await runCli(["mcp", "--skills=nope"], SENTRY_CLI);

    expect(stderr).toContain("bad --skills");
    expect(process.exitCode).toBeGreaterThan(0);
    expect(mocks.closeGlobalDispatcher).toHaveBeenCalledOnce();
  });

  test("--help prints Stricli help without serving", async () => {
    await runCli(["mcp", "--help"], SENTRY_CLI);

    expect(mocks.serveMcp).not.toHaveBeenCalled();
    for (const flag of [
      "--access-token",
      "--host",
      "--url",
      "--insecure-http",
      "--skills",
      "--all-skills",
      "--disable-skills",
      "--agent-provider",
      "--mcp-url",
      "--sentry-dsn",
    ]) {
      expect(stdout).toContain(flag);
    }
    expect(stdout).toContain("SENTRY_ACCESS_TOKEN");
    expect(stdout).toContain(`Available skills: ${ALL_SKILLS.join(", ")}`);
  });

  test("help lists mcp-core's skills", () => {
    expect([...MCP_SKILL_NAMES]).toEqual(ALL_SKILLS);
  });

  test("rejects unknown flags", async () => {
    await runCli(["mcp", "--bogus"], SENTRY_CLI);

    expect(mocks.serveMcp).not.toHaveBeenCalled();
    expect(stderr).toContain("--bogus");
    // Stricli's raw (negative) argument-error code; Node.js exits with 252.
    expect(process.exitCode).toBeLessThan(0);
  });
});
