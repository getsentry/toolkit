import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ValidationError } from "../../../src/lib/errors.js";

const assertAutoLoginHostTrusted = vi.fn();
const runInteractiveLogin = vi.fn();

vi.mock("../../../src/lib/auto-auth.js", () => ({
  assertAutoLoginHostTrusted: () => assertAutoLoginHostTrusted(),
}));
vi.mock("../../../src/lib/interactive-login.js", () => ({
  runInteractiveLogin: (...args: unknown[]) => runInteractiveLogin(...args),
}));

const { runMcpServerAuth } = await import("../../../src/lib/mcp/auth.js");

const originalExitCode = process.exitCode;
let stderr: string;

beforeEach(() => {
  assertAutoLoginHostTrusted.mockReset();
  runInteractiveLogin.mockReset();
  stderr = "";
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
});

describe("runMcpServerAuth", () => {
  test.each([[[]], [["login"]]])("logs in for %j", async (args) => {
    runInteractiveLogin.mockResolvedValue({
      method: "oauth",
      configPath: "/tmp/cli.db",
      user: { email: "user@example.com" },
    });

    await runMcpServerAuth(args);

    expect(assertAutoLoginHostTrusted).toHaveBeenCalledTimes(1);
    expect(runInteractiveLogin).toHaveBeenCalledTimes(1);
    expect(stderr).toBe("Logged in as user@example.com.\n");
    expect(process.exitCode).toBe(originalExitCode);
  });

  test("checks the host before starting the device flow", async () => {
    assertAutoLoginHostTrusted.mockImplementation(() => {
      throw new ValidationError("untrusted host");
    });

    await expect(runMcpServerAuth(["login"])).rejects.toThrow("untrusted host");
    expect(runInteractiveLogin).not.toHaveBeenCalled();
  });

  test("fails when the login does not complete", async () => {
    runInteractiveLogin.mockResolvedValue(null);

    await runMcpServerAuth(["login"]);

    expect(process.exitCode).toBe(1);
  });

  test.each([[["status"]], [["logout"]], [["login", "--url=x"]]])(
    "points %j to the CLI",
    async (args) => {
      await expect(runMcpServerAuth(args)).rejects.toThrow(
        `npx -y sentry auth ${args.join(" ")}`,
      );
      expect(runInteractiveLogin).not.toHaveBeenCalled();
    },
  );
});
