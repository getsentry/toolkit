import { afterEach, describe, expect, test } from "vitest";
import {
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

  test("the sentry tag inserts interpolated values as they are", () => {
    setAppIdentity({ name: "sentry-mcp", packageName: "@sentry/mcp-server" });
    const built = sentry`issue view 1`;
    expect(sentry`help ${built}`).toBe(
      "sentry-mcp help sentry-mcp issue view 1",
    );
    // Text that only looks like a command, such as a search, stays as typed
    const query = "sentry issue view";
    expect(sentry`issue list --query ${query}`).toBe(
      "sentry-mcp issue list --query sentry issue view",
    );
    expect(sentry`issue list ${"sentry"}/`).toBe(
      "sentry-mcp issue list sentry/",
    );
  });

  test("a command kept in a constant is built when it is shown", () => {
    const usageHint = () => sentry`org list`;
    setAppIdentity({ name: "sentry-mcp", packageName: "@sentry/mcp-server" });
    expect(usageHint()).toBe("sentry-mcp org list");

    process.env.npm_command = "exec";
    const context = new ContextError("Organization", usageHint());
    expect(context.command).toBe("npx -y @sentry/mcp-server org list");
    expect(context.message).toContain("npx -y @sentry/mcp-server org list");
  });

  test("error usage lines are shown as given", () => {
    process.env.npm_command = "exec";
    const resolution = new ResolutionError(
      "Project 'web'",
      "not found",
      sentry`project view <org>/web`,
      [sentry`project list <org>/`],
    );
    expect(resolution.hint).toBe("npx -y sentry project view <org>/web");
    expect(resolution.suggestions).toEqual([
      "npx -y sentry project list <org>/",
    ]);
  });
});
