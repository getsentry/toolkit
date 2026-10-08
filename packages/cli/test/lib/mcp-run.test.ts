import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const startMcpServer = vi.fn();
const scheduleForceExit = vi.fn();
const closeGlobalDispatcher = vi.fn(() => Promise.resolve());

vi.mock("../../src/lib/mcp.js", () => ({
  startMcpServer: (...args: unknown[]) => startMcpServer(...args),
}));
vi.mock("../../src/lib/force-exit.js", () => ({
  scheduleForceExit: (...args: unknown[]) => scheduleForceExit(...args),
}));
vi.mock("../../src/lib/close-dispatcher.js", () => ({
  closeGlobalDispatcher: (...args: unknown[]) => closeGlobalDispatcher(...args),
}));

const originalExitCode = process.exitCode;

beforeEach(() => {
  startMcpServer.mockReset();
  scheduleForceExit.mockReset();
  closeGlobalDispatcher.mockReset();
  closeGlobalDispatcher.mockImplementation(() => Promise.resolve());
});

afterEach(() => {
  process.exitCode = originalExitCode;
});

describe("runMcpCommand", () => {
  test("does not handle non-mcp invocations", async () => {
    const { runMcpCommand } = await import("../../src/cli.js");

    await expect(runMcpCommand(["issue", "list"])).resolves.toBe(false);
    expect(startMcpServer).not.toHaveBeenCalled();
  });

  test("keeps a running server alive on success", async () => {
    startMcpServer.mockResolvedValue(undefined);
    const { runMcpCommand } = await import("../../src/cli.js");

    await expect(runMcpCommand(["mcp"])).resolves.toBe(true);

    expect(startMcpServer).toHaveBeenCalledWith([]);
    // A live stdio server must not be force-exited or have its dispatcher
    // destroyed — those would kill the server right after it starts.
    expect(scheduleForceExit).not.toHaveBeenCalled();
    expect(closeGlobalDispatcher).not.toHaveBeenCalled();
  });

  test("cleans up network resources when setup fails", async () => {
    startMcpServer.mockRejectedValue(new Error("boom"));
    const { runMcpCommand } = await import("../../src/cli.js");

    await expect(runMcpCommand(["mcp"])).resolves.toBe(true);

    // A terminal setup failure never reaches the main runCli finally, so the
    // undici dispatcher and force-exit backstop must be handled here.
    expect(scheduleForceExit).toHaveBeenCalledTimes(1);
    expect(closeGlobalDispatcher).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeGreaterThan(0);
  });
});
