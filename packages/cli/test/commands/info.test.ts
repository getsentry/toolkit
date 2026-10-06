/**
 * Tests for `sentry info`.
 *
 * Drives the command via its wrapper `loader()`, spying the auth/config getters
 * and the `/auth/` verification call so no network or real config is needed.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { infoCommand } from "../../src/commands/info.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as users from "../../src/lib/api/users.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as auth from "../../src/lib/db/auth.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as defaults from "../../src/lib/db/defaults.js";

function createContext(env: NodeJS.ProcessEnv = {}) {
  const writes: string[] = [];
  return {
    context: {
      stdout: {
        write: (data: string | Uint8Array) => {
          writes.push(
            typeof data === "string" ? data : new TextDecoder().decode(data)
          );
          return true;
        },
      },
      stderr: { write: () => true },
      cwd: "/tmp",
      env,
      process: { ...process, exitCode: undefined } as typeof process,
    },
    output: () => writes.join(""),
    get exitCode() {
      return this.context.process.exitCode;
    },
  };
}

describe("sentry info", () => {
  beforeEach(() => {
    vi.spyOn(defaults, "getDefaultUrl").mockReturnValue(null);
    vi.spyOn(defaults, "getDefaultOrganization").mockReturnValue(null);
    vi.spyOn(defaults, "getDefaultProject").mockReturnValue(null);
    vi.spyOn(auth, "isAuthenticated").mockReturnValue(false);
    vi.spyOn(users, "getCurrentUser").mockRejectedValue(new Error("no auth"));
  });
  afterEach(() => vi.restoreAllMocks());

  test("reports unauthenticated and exits 1", async () => {
    const harness = createContext();
    const func = await infoCommand.loader();

    await func.call(harness.context, {});

    expect(harness.output()).toContain("Unauthorized");
    expect(harness.exitCode).toBe(1);
  });

  test("verifies auth and shows the user (exit 0)", async () => {
    vi.spyOn(auth, "isAuthenticated").mockReturnValue(true);
    vi.spyOn(users, "getCurrentUser").mockResolvedValue({
      id: "1",
      email: "me@example.com",
      name: "Me",
    } as Awaited<ReturnType<typeof users.getCurrentUser>>);
    vi.spyOn(defaults, "getDefaultOrganization").mockReturnValue("acme");
    vi.spyOn(defaults, "getDefaultProject").mockReturnValue("web");

    const harness = createContext();
    const func = await infoCommand.loader();
    await func.call(harness.context, {});

    expect(harness.output()).toContain("me@example.com");
    expect(harness.exitCode ?? 0).toBe(0);
  });

  test("authenticated but verification fails exits 1", async () => {
    vi.spyOn(auth, "isAuthenticated").mockReturnValue(true);
    // getCurrentUser rejects (default) → successful false.
    const harness = createContext();
    const func = await infoCommand.loader();
    await func.call(harness.context, {});
    expect(harness.exitCode).toBe(1);
  });

  test("--config-status-json emits JSON and always exits 0", async () => {
    const harness = createContext();
    const func = await infoCommand.loader();

    await func.call(harness.context, { "config-status-json": true });

    const parsed = JSON.parse(harness.output());
    expect(parsed).toHaveProperty("config");
    expect(parsed).toHaveProperty("auth.successful", false);
    expect(parsed).toHaveProperty("have_dsn", false);
    expect(harness.exitCode ?? 0).toBe(0);
  });

  test("--no-defaults ignores missing org/project (only auth matters)", async () => {
    vi.spyOn(auth, "isAuthenticated").mockReturnValue(true);
    vi.spyOn(users, "getCurrentUser").mockResolvedValue({
      id: "1",
      email: "me@example.com",
    } as Awaited<ReturnType<typeof users.getCurrentUser>>);

    const harness = createContext();
    const func = await infoCommand.loader();
    await func.call(harness.context, { "no-defaults": true });
    expect(harness.exitCode ?? 0).toBe(0);
  });

  test("reads defaults from environment variables", async () => {
    const harness = createContext({
      SENTRY_URL: "https://sentry.example.com",
      SENTRY_ORG: "envorg",
      SENTRY_DSN: "https://k@o.ingest.sentry.io/1",
    });
    const func = await infoCommand.loader();
    await func.call(harness.context, { "config-status-json": true });

    const parsed = JSON.parse(harness.output());
    expect(parsed.config.url).toBe("https://sentry.example.com");
    expect(parsed.config.org).toBe("envorg");
    expect(parsed.have_dsn).toBe(true);
  });
});
