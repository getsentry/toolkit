/**
 * `sentry auth list` / `sentry auth switch` command tests against a real
 * test database.
 */

import { describe, expect, test, vi } from "vitest";
import { listCommand } from "../../../src/commands/auth/list.js";
import { switchCommand } from "../../../src/commands/auth/switch.js";
import { listAccounts } from "../../../src/lib/db/accounts.js";
import { getAuthToken, setAuthToken } from "../../../src/lib/db/auth.js";
import { getDefaultUrl, setDefaultUrl } from "../../../src/lib/db/defaults.js";
import { setUserInfo } from "../../../src/lib/db/user.js";
import {
  AuthError,
  ContextError,
  ResolutionError,
} from "../../../src/lib/errors.js";
import { useEnvSandbox, useTestConfigDir } from "../../helpers.js";

type ListFunc = (this: unknown, flags: { json?: boolean }) => Promise<void>;
type SwitchFunc = (
  this: unknown,
  flags: { json?: boolean },
  selector?: string,
) => Promise<void>;

useTestConfigDir("auth-switch-");
useEnvSandbox([
  "SENTRY_AUTH_TOKEN",
  "SENTRY_TOKEN",
  "SENTRY_FORCE_ENV_TOKEN",
  "SENTRY_HOST",
  "SENTRY_URL",
]);

function createContext() {
  const chunks: string[] = [];
  return {
    context: {
      stdout: { write: vi.fn((s: string) => chunks.push(s)) },
      stderr: { write: vi.fn(() => true) },
      cwd: "/tmp",
    },
    getOutput: () => chunks.join(""),
  };
}

function addAccount(
  token: string,
  host: string,
  user: { userId: string; email: string },
): string {
  const id = setAuthToken(token, undefined, undefined, {
    host,
    newAccount: true,
  });
  setUserInfo(user);
  return id;
}

function seedTwoAccounts(): { saas: string; selfHosted: string } {
  const saas = addAccount("saas-token", "https://sentry.io", {
    userId: "1",
    email: "jane@example.com",
  });
  const selfHosted = addAccount("self-token", "https://sentry.example.com", {
    userId: "9",
    email: "jane@corp.example.com",
  });
  setDefaultUrl("https://sentry.example.com");
  return { saas, selfHosted };
}

describe("auth list", () => {
  test("lists every stored account and marks the active one", async () => {
    seedTwoAccounts();
    const func = (await listCommand.loader()) as unknown as ListFunc;
    const { context, getOutput } = createContext();

    await func.call(context, { json: false });

    const out = getOutput();
    expect(out).toContain("jane@example.com");
    expect(out).toContain("jane@corp.example.com");
    expect(out).toContain("sentry.example.com");
    expect(out).toContain("active");
  });

  test("--json outputs account summaries without secrets", async () => {
    seedTwoAccounts();
    const func = (await listCommand.loader()) as unknown as ListFunc;
    const { context, getOutput } = createContext();

    await func.call(context, { json: true });

    const out = getOutput();
    const parsed = JSON.parse(out) as Array<Record<string, unknown>>;
    expect(parsed.map((a) => [a.email, a.active])).toEqual([
      ["jane@example.com", false],
      ["jane@corp.example.com", true],
    ]);
    expect(out).not.toContain("saas-token");
    expect(out).not.toContain("self-token");
  });

  test("shows a login hint when nothing is stored", async () => {
    const func = (await listCommand.loader()) as unknown as ListFunc;
    const { context, getOutput } = createContext();

    await func.call(context, { json: false });

    expect(getOutput()).toContain("No stored accounts");
  });
});

describe("auth switch", () => {
  test("switches by email and points the default URL at the account's server", async () => {
    seedTwoAccounts();
    const func = (await switchCommand.loader()) as unknown as SwitchFunc;
    const { context, getOutput } = createContext();

    await func.call(context, { json: false }, "jane@example.com");

    expect(getAuthToken()).toBe("saas-token");
    // SaaS clears the self-hosted default so commands route to sentry.io.
    expect(getDefaultUrl()).toBeNull();
    expect(getOutput()).toContain("Switched to jane@example.com on sentry.io");
  });

  test("switching to a self-hosted account stores its URL as the default", async () => {
    const { saas, selfHosted } = seedTwoAccounts();
    const func = (await switchCommand.loader()) as unknown as SwitchFunc;
    await func.call(createContext().context, { json: false }, saas);

    await func.call(createContext().context, { json: false }, selfHosted);

    expect(getAuthToken()).toBe("self-token");
    expect(getDefaultUrl()).toBe("https://sentry.example.com");
  });

  test("reports when the account is already active", async () => {
    seedTwoAccounts();
    const func = (await switchCommand.loader()) as unknown as SwitchFunc;
    const { context, getOutput } = createContext();

    await func.call(context, { json: false }, "jane@corp.example.com");

    expect(getOutput()).toContain("Already using");
    expect(getAuthToken()).toBe("self-token");
  });

  test("unknown account throws ResolutionError and keeps the active account", async () => {
    seedTwoAccounts();
    const func = (await switchCommand.loader()) as unknown as SwitchFunc;

    await expect(
      func.call(createContext().context, { json: false }, "nobody"),
    ).rejects.toBeInstanceOf(ResolutionError);
    expect(getAuthToken()).toBe("self-token");
  });

  test("an ambiguous selector throws ResolutionError listing the candidates", async () => {
    addAccount("a", "https://sentry.io", {
      userId: "1",
      email: "jane@example.com",
    });
    addAccount("b", "https://sentry.example.com", {
      userId: "1",
      email: "jane@example.com",
    });
    const func = (await switchCommand.loader()) as unknown as SwitchFunc;

    const error = await func
      .call(createContext().context, { json: false }, "jane@example.com")
      .catch((e) => e);

    expect(error).toBeInstanceOf(ResolutionError);
    expect(String((error as Error).message)).toContain("sentry.example.com");
  });

  test("without an argument in a non-interactive shell, asks for an account", async () => {
    seedTwoAccounts();
    const func = (await switchCommand.loader()) as unknown as SwitchFunc;

    await expect(
      func.call(createContext().context, { json: false }),
    ).rejects.toBeInstanceOf(ContextError);
  });

  test("with no stored accounts, throws not-authenticated", async () => {
    const func = (await switchCommand.loader()) as unknown as SwitchFunc;

    await expect(
      func.call(createContext().context, { json: false }, "anyone"),
    ).rejects.toBeInstanceOf(AuthError);
    expect(listAccounts()).toEqual([]);
  });
});

describe("auth switch selection", () => {
  test("uses a close match with a warning", async () => {
    const { saas } = seedTwoAccounts();
    const func = (await switchCommand.loader()) as unknown as SwitchFunc;

    await func.call(createContext().context, { json: false }, "jane@example");

    expect(getAuthToken()).toBe("saas-token");
    expect(listAccounts().find((a) => a.active)?.id).toBe(saas);
  });

  test("--url without an account switches to the only account on that server", async () => {
    seedTwoAccounts();
    const func = (await switchCommand.loader()) as unknown as SwitchFunc;

    await func.call(createContext().context, {
      json: false,
      url: "https://sentry.io",
    } as { json: boolean });

    expect(getAuthToken()).toBe("saas-token");
  });
});
