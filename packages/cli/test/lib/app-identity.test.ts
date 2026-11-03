import { afterEach, describe, expect, test } from "vitest";
import {
  asRunningAppCommand,
  getLoginCommand,
  getUrlLoginCommand,
  setAppIdentity,
} from "../../src/lib/app-identity.js";
import { AuthError } from "../../src/lib/errors.js";
import { useEnvSandbox } from "../helpers.js";

useEnvSandbox(["npm_command"]);

const argv1 = process.argv[1];

afterEach(() => {
  setAppIdentity({ name: "sentry", packageName: "sentry" });
  process.argv[1] = argv1 ?? "";
});

describe("app identity", () => {
  test("hints name the sentry CLI by default", () => {
    expect(getLoginCommand()).toBe("sentry auth login");
    expect(new AuthError("not_authenticated").message).toBe(
      "Not authenticated. Run 'sentry auth login' first.",
    );
  });

  test("hints name @sentry/mcp-server's binary once it registers", () => {
    setAppIdentity({ name: "sentry-mcp", packageName: "@sentry/mcp-server" });
    expect(getUrlLoginCommand()).toBe("sentry-mcp auth login --url");
    expect(new AuthError("expired").message).toBe(
      "Authentication expired. Run 'sentry-mcp auth login' to re-authenticate.",
    );
  });

  test("hints go through npx when npx launched the process", () => {
    setAppIdentity({ name: "sentry-mcp", packageName: "@sentry/mcp-server" });
    process.env.npm_command = "exec";
    expect(getLoginCommand()).toBe("npx -y @sentry/mcp-server auth login");

    delete process.env.npm_command;
    process.argv[1] = "/home/u/.npm/_npx/abc/node_modules/.bin/sentry-mcp";
    expect(getLoginCommand()).toBe("npx -y @sentry/mcp-server auth login");
  });

  test("rewrites only a leading `sentry ` in example commands", () => {
    setAppIdentity({ name: "sentry-mcp", packageName: "@sentry/mcp-server" });
    expect(asRunningAppCommand("sentry auth login --url x")).toBe(
      "sentry-mcp auth login --url x",
    );
    expect(asRunningAppCommand("npx sentry auth")).toBe("npx sentry auth");
    expect(asRunningAppCommand("sentry-cli login")).toBe("sentry-cli login");
  });
});
