import { ALL_SKILLS } from "@sentry/mcp-core/skills";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { routes } from "../../src/app.js";
import { type CliEntry, isMcpInvocation, runCli } from "../../src/cli.js";
import { MCP_SKILL_NAMES } from "../../src/commands/mcp.js";
import { ValidationError } from "../../src/lib/errors.js";
import { logger, parseLogLevel } from "../../src/lib/logger.js";
import { routes as mcpServerRoutes } from "../../src/mcp-server-app.js";
import { SENTRY_CLI } from "../../src/sentry-cli.js";
import { useTestConfigDir } from "../helpers.js";

const mocks = vi.hoisted(() => ({
  serveMcp: vi.fn(),
  withTelemetry: vi.fn(),
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

  test("reads a first word that names no route as the default command's target", () => {
    expect(isMcpInvocation(mcpServerRoutes, ["acme/web"])).toBe(true);
    expect(isMcpInvocation(mcpServerRoutes, ["--all-skills", "acme/"])).toBe(
      true,
    );
    expect(isMcpInvocation(mcpServerRoutes, ["mcp", "acme/"])).toBe(true);
    // Route names win over a target, so they still reach their command.
    expect(isMcpInvocation(mcpServerRoutes, ["auth"])).toBe(false);
    // Without `mcp` as the default, a first word is a command, never a target.
    expect(isMcpInvocation(routes, ["acme/web"])).toBe(false);
  });
});

describe("@sentry/mcp-server application", () => {
  test("has only mcp, auth, cli, and help, with mcp as the default", () => {
    expect(
      mcpServerRoutes.getAllEntries().map((entry) => entry.name.original),
    ).toEqual(["mcp", "auth", "cli", "help"]);
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

  test("starts the server for an <org>/<project> target", async () => {
    await runCli(["acme/web", "--all-skills"], MCP_SERVER);

    expect(stderr).toBe("");
    expect(mocks.serveMcp).toHaveBeenCalledOnce();
    expect(mocks.serveMcp.mock.lastCall?.[0]).toMatchObject({
      "all-skills": true,
    });
    expect(mocks.serveMcp.mock.lastCall?.[2]).toEqual({
      org: "acme",
      project: "web",
    });
    expect(mocks.withTelemetry).not.toHaveBeenCalled();
  });

  test("rejects a bare slug target with a hint", async () => {
    await runCli(["acme"], MCP_SERVER);

    expect(mocks.serveMcp).not.toHaveBeenCalled();
    expect(stderr).toContain("acme/");
    expect(stdout).toBe("");
  });
});

describe("running `mcp`", () => {
  test("passes the <org>/ target to the server", async () => {
    await runCli(["mcp", "acme/"], SENTRY_CLI);

    expect(mocks.serveMcp).toHaveBeenCalledOnce();
    expect(mocks.serveMcp.mock.lastCall?.[2]).toEqual({ org: "acme" });
  });

  test("applies SENTRY_LOG_LEVEL before the server starts", async () => {
    const originalLevel = logger.level;
    vi.stubEnv("SENTRY_LOG_LEVEL", "error");
    let levelAtStart: number | undefined;
    mocks.serveMcp.mockImplementation(() => {
      levelAtStart = logger.level;
      return Promise.resolve();
    });
    try {
      await runCli(["mcp"], SENTRY_CLI);
    } finally {
      vi.unstubAllEnvs();
      logger.level = originalLevel;
    }

    expect(levelAtStart).toBe(parseLogLevel("error"));
  });

  test("serves through Stricli, without the CLI's telemetry", async () => {
    await runCli(["mcp", "--access-token=tok"], SENTRY_CLI);

    expect(mocks.serveMcp).toHaveBeenCalledOnce();
    expect(mocks.serveMcp.mock.lastCall?.[0]).toMatchObject({
      "access-token": "tok",
    });
    expect(mocks.withTelemetry).not.toHaveBeenCalled();
  });

  test("ignores --json and --fields before `mcp`", async () => {
    for (const leading of [
      ["--json"],
      ["--no-json"],
      ["--fields", "id,title"],
      ["--fields=id"],
      ["--json", "--fields", "id"],
    ]) {
      mocks.serveMcp.mockClear();
      process.exitCode = originalExitCode;

      await runCli(
        [...leading, "mcp", "--host=sentry.example.com"],
        SENTRY_CLI,
      );

      expect(stderr).toBe("");
      expect(mocks.serveMcp).toHaveBeenCalledOnce();
      expect(mocks.serveMcp.mock.lastCall?.[0]).toMatchObject({
        host: "sentry.example.com",
      });
    }
  });

  test("ignores --json and --fields before the default command", async () => {
    await runCli(["--json", "--fields", "id", "--all-skills"], MCP_SERVER);

    expect(stderr).toBe("");
    expect(mocks.serveMcp).toHaveBeenCalledOnce();
    expect(mocks.serveMcp.mock.lastCall?.[0]).toMatchObject({
      "all-skills": true,
    });
  });

  test("rejects --json after `mcp`, where flags are the server's", async () => {
    await runCli(["mcp", "--json"], SENTRY_CLI);

    expect(mocks.serveMcp).not.toHaveBeenCalled();
    expect(stderr).toContain("--json");
    expect(process.exitCode).toBeLessThan(0);
  });

  test("passes the context's working directory, which survives a deleted one", async () => {
    vi.spyOn(process, "cwd").mockImplementation(() => {
      throw Object.assign(new Error("uv_cwd"), { code: "ENOENT" });
    });
    const savedPwd = process.env.PWD;
    process.env.PWD = "/deleted/worktree";
    try {
      await runCli(["mcp", "--host=sentry.example.com"], SENTRY_CLI);
    } finally {
      process.env.PWD = savedPwd;
      vi.mocked(process.cwd).mockRestore();
    }

    expect(mocks.serveMcp).toHaveBeenCalledOnce();
    expect(mocks.serveMcp.mock.lastCall?.[1]).toBe("/deleted/worktree");
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
    // A live stdio server must not lose its dispatcher.
    expect(mocks.closeGlobalDispatcher).not.toHaveBeenCalled();

    finishServing();
    await running;
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
