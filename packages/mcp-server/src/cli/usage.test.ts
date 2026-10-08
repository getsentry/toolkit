import { describe, expect, it } from "vitest";
import { runMcpServer } from "../index";
import { buildUsage } from "./usage";

describe("buildUsage", () => {
  it("describes host authentication without standalone login commands", () => {
    const usage = buildUsage("sentry mcp", ["inspect"], {
      usesHostAuthentication: true,
    });

    expect(usage).toContain("Uses the active Sentry CLI session");
    expect(usage).toContain("sentry auth login");
    expect(usage).not.toContain("device code flow");
    expect(usage).not.toContain("--access-token");
    expect(usage).not.toContain("auth [login|logout|status]");
  });
});

describe("runMcpServer", () => {
  it("returns host application setup errors without exiting", async () => {
    await expect(
      runMcpServer([], {
        throwOnError: true,
        resolveAccessToken: async () => {
          throw new Error("No active CLI session");
        },
      }),
    ).rejects.toThrow("No active CLI session");
  });

  it("does not allow standalone auth commands with host authentication", async () => {
    await expect(
      runMcpServer(["auth", "login"], {
        throwOnError: true,
        resolveAccessToken: async () => "token",
      }),
    ).rejects.toThrow("Use `sentry auth`");
  });
});
