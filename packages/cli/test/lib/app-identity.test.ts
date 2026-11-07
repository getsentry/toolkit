import { afterEach, describe, expect, test } from "vitest";
import {
  asInvocationCommand,
  getLoginCommand,
  getUrlLoginCommand,
  sentry,
  setAppIdentity,
} from "../../src/lib/app-identity.js";
import {
  AuthError,
  ContextError,
  ResolutionError,
} from "../../src/lib/errors.js";
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

  test("rewrites only a leading `sentry ` in runtime commands", () => {
    setAppIdentity({ name: "sentry-mcp", packageName: "@sentry/mcp-server" });
    expect(asInvocationCommand("sentry auth login --url x")).toBe(
      "sentry-mcp auth login --url x",
    );
    expect(asInvocationCommand("npx sentry auth")).toBe("npx sentry auth");
    expect(asInvocationCommand("sentry-cli login")).toBe("sentry-cli login");
  });

  test("the sentry tag names the running program", () => {
    const org = "acme";
    expect(sentry`issue list ${org}/`).toBe("sentry issue list acme/");

    setAppIdentity({ name: "sentry-mcp", packageName: "@sentry/mcp-server" });
    expect(sentry`issue list ${org}/`).toBe("sentry-mcp issue list acme/");

    process.env.npm_command = "exec";
    expect(sentry`issue list ${org}/`).toBe(
      "npx -y @sentry/mcp-server issue list acme/",
    );
  });

  test("the sentry tag rewrites interpolated commands once", () => {
    setAppIdentity({ name: "sentry-mcp", packageName: "@sentry/mcp-server" });
    const usage = "sentry issue view <id>";
    expect(sentry`help ${usage}`).toBe(
      "sentry-mcp help sentry-mcp issue view <id>",
    );
    const built = sentry`issue view 1`;
    expect(sentry`help ${built}`).toBe(
      "sentry-mcp help sentry-mcp issue view 1",
    );
    expect(sentry`issue list ${"sentry"}/`).toBe(
      "sentry-mcp issue list sentry/",
    );
  });

  test("command hints run this program again", () => {
    const command = "sentry cli fix";
    expect(asInvocationCommand(command)).toBe(command);

    setAppIdentity({ name: "sentry-mcp", packageName: "@sentry/mcp-server" });
    expect(asInvocationCommand(command)).toBe("sentry-mcp cli fix");

    process.env.npm_command = "exec";
    expect(asInvocationCommand(command)).toBe(
      "npx -y @sentry/mcp-server cli fix",
    );
  });

  test("error usage lines name the running program under npx", () => {
    process.env.npm_command = "exec";
    const context = new ContextError("Organization", "sentry org list");
    expect(context.command).toBe("npx -y sentry org list");
    expect(context.message).toContain("npx -y sentry org list");

    const resolution = new ResolutionError(
      "Project 'web'",
      "not found",
      "sentry project view <org>/web",
      ["sentry project list <org>/"],
    );
    expect(resolution.hint).toBe("npx -y sentry project view <org>/web");
    expect(resolution.suggestions).toEqual([
      "npx -y sentry project list <org>/",
    ]);
  });
});
