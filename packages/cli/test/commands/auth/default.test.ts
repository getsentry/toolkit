/**
 * Tests for bare `sentry auth` smart default routing.
 */

import { describe, expect, test, vi } from "vitest";
import {
  authDefaultCommand,
  resolveAuthDefaultTarget,
} from "../../../src/commands/auth/default.js";
import { loginCommand } from "../../../src/commands/auth/login.js";
import { statusCommand } from "../../../src/commands/auth/status.js";
import { CommandOutput } from "../../../src/lib/formatters/output.js";

describe("resolveAuthDefaultTarget", () => {
  test("logged out → login", () => {
    expect(resolveAuthDefaultTarget({}, false)).toBe("login");
  });

  test("logged in → status", () => {
    expect(resolveAuthDefaultTarget({}, true)).toBe("status");
  });

  test("login-only flags force login even when authenticated", () => {
    expect(resolveAuthDefaultTarget({ token: "t" }, true)).toBe("login");
    expect(resolveAuthDefaultTarget({ force: true }, true)).toBe("login");
    expect(
      resolveAuthDefaultTarget({ url: "https://sentry.example.com" }, true)
    ).toBe("login");
    expect(resolveAuthDefaultTarget({ "read-only": true }, true)).toBe("login");
    expect(resolveAuthDefaultTarget({ scope: ["org:read"] }, true)).toBe(
      "login"
    );
  });

  test("status-only flags keep status when authenticated", () => {
    expect(
      resolveAuthDefaultTarget({ "show-token": true, fresh: true }, true)
    ).toBe("status");
  });

  test("empty scope array does not force login", () => {
    expect(resolveAuthDefaultTarget({ scope: [] }, true)).toBe("status");
  });
});

describe("authDefaultCommand", () => {
  test("dispatches to login raw func when logged out", async () => {
    const isAuthenticated = vi.spyOn(
      await import("../../../src/lib/db/auth.js"),
      "isAuthenticated"
    );
    isAuthenticated.mockReturnValue(false);

    const loginRaw = vi.fn(async function* () {
      yield new CommandOutput({
        method: "token",
        configPath: "/tmp/sentry.db",
      });
    });
    const statusRaw = vi.fn(async function* () {
      yield new CommandOutput({ authenticated: true, source: "oauth" });
    });

    const loginCmd = loginCommand as unknown as { __rawFunc: unknown };
    const statusCmd = statusCommand as unknown as { __rawFunc: unknown };
    const prevLogin = loginCmd.__rawFunc;
    const prevStatus = statusCmd.__rawFunc;
    loginCmd.__rawFunc = loginRaw;
    statusCmd.__rawFunc = statusRaw;

    const context = {
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
      cwd: "/tmp",
      env: process.env,
    };

    try {
      const func = await authDefaultCommand.loader();
      await func.call(context as never, {
        timeout: 900,
        force: false,
        "read-only": false,
        "show-token": false,
        fresh: false,
        json: false,
      });

      expect(loginRaw).toHaveBeenCalledOnce();
      expect(statusRaw).not.toHaveBeenCalled();
    } finally {
      loginCmd.__rawFunc = prevLogin;
      statusCmd.__rawFunc = prevStatus;
      isAuthenticated.mockRestore();
    }
  });

  test("dispatches to status raw func when logged in", async () => {
    const isAuthenticated = vi.spyOn(
      await import("../../../src/lib/db/auth.js"),
      "isAuthenticated"
    );
    isAuthenticated.mockReturnValue(true);

    const loginRaw = vi.fn(async function* () {
      yield new CommandOutput({
        method: "token",
        configPath: "/tmp/sentry.db",
      });
    });
    const statusRaw = vi.fn(async function* () {
      yield new CommandOutput({ authenticated: true, source: "oauth" });
    });

    const loginCmd = loginCommand as unknown as { __rawFunc: unknown };
    const statusCmd = statusCommand as unknown as { __rawFunc: unknown };
    const prevLogin = loginCmd.__rawFunc;
    const prevStatus = statusCmd.__rawFunc;
    loginCmd.__rawFunc = loginRaw;
    statusCmd.__rawFunc = statusRaw;

    const context = {
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
      cwd: "/tmp",
      env: process.env,
    };

    try {
      const func = await authDefaultCommand.loader();
      await func.call(context as never, {
        timeout: 900,
        force: false,
        "read-only": false,
        "show-token": false,
        fresh: false,
        json: false,
      });

      expect(statusRaw).toHaveBeenCalledOnce();
      expect(loginRaw).not.toHaveBeenCalled();
    } finally {
      loginCmd.__rawFunc = prevLogin;
      statusCmd.__rawFunc = prevStatus;
      isAuthenticated.mockRestore();
    }
  });
});
