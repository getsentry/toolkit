/**
 * Account selector resolution and the interactive account picker used by
 * `sentry auth switch` / `logout`.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";

const { selectWithFilter, isatty } = vi.hoisted(() => ({
  selectWithFilter: vi.fn(),
  isatty: vi.fn(() => true),
}));
vi.mock("../../src/lib/init/ui/ink-ui.js", () => ({ selectWithFilter }));
vi.mock("node:tty", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:tty")>()),
  isatty,
}));

import {
  promptForAccount,
  resolveAccountSelector,
} from "../../src/lib/account-selection.js";
import {
  findSimilarAccounts,
  listAccounts,
} from "../../src/lib/db/accounts.js";
import { setAuthToken } from "../../src/lib/db/auth.js";
import { setUserInfo } from "../../src/lib/db/user.js";
import { ResolutionError } from "../../src/lib/errors.js";
import { useEnvSandbox, useTestConfigDir } from "../helpers.js";

useTestConfigDir("account-selection-");
useEnvSandbox(["SENTRY_AUTH_TOKEN", "SENTRY_TOKEN", "SENTRY_FORCE_ENV_TOKEN"]);

function addAccount(
  host: string,
  user: { userId: string; email: string; username?: string },
): string {
  const id = setAuthToken(
    `token-${user.userId}-${host}`,
    undefined,
    undefined,
    {
      host,
      newAccount: true,
    },
  );
  setUserInfo(user);
  return id;
}

beforeEach(() => {
  selectWithFilter.mockReset();
  isatty.mockReturnValue(true);
});

describe("resolveAccountSelector", () => {
  test("uses a sole fuzzy match with fuzzy enabled", () => {
    const work = addAccount("https://sentry.io", {
      userId: "1",
      email: "jane@acme.com",
    });
    addAccount("https://sentry.io", { userId: "2", email: "bob@other.dev" });

    expect(
      resolveAccountSelector("jane", "sentry auth switch", { fuzzy: true }).id,
    ).toBe(work);
    expect(
      resolveAccountSelector("jane@acme.co", "sentry auth switch", {
        fuzzy: true,
      }).id,
    ).toBe(work);
  });

  test("only suggests fuzzy matches without fuzzy", () => {
    addAccount("https://sentry.io", { userId: "1", email: "jane@acme.com" });

    expect(() => resolveAccountSelector("jane", "sentry auth logout")).toThrow(
      /Did you mean jane@acme\.com/,
    );
  });

  test("--url disambiguates the same email on several servers", () => {
    addAccount("https://sentry.io", { userId: "1", email: "jane@acme.com" });
    const selfHosted = addAccount("https://sentry.acme.com", {
      userId: "1",
      email: "jane@acme.com",
    });

    expect(() =>
      resolveAccountSelector("jane@acme.com", "sentry auth switch"),
    ).toThrow(ResolutionError);
    expect(
      resolveAccountSelector("jane@acme.com", "sentry auth switch", {
        url: "https://sentry.acme.com",
      }).id,
    ).toBe(selfHosted);
  });

  test("treats every sentry.io region as the SaaS server for --url", () => {
    const saas = addAccount("https://sentry.io", {
      userId: "1",
      email: "jane@acme.com",
    });
    addAccount("https://sentry.acme.com", {
      userId: "1",
      email: "jane@acme.com",
    });

    expect(
      resolveAccountSelector("jane@acme.com", "sentry auth switch", {
        url: "https://us.sentry.io",
      }).id,
    ).toBe(saas);
  });
});

describe("findSimilarAccounts", () => {
  test("ranks accounts with the shared fuzzy matcher", () => {
    addAccount("https://sentry.io", { userId: "1", email: "jane@acme.com" });
    addAccount("https://sentry.io", { userId: "2", email: "janet@acme.com" });
    addAccount("https://sentry.io", { userId: "3", email: "bob@other.dev" });

    expect(findSimilarAccounts("jane").map((a) => a.email)).toEqual([
      "jane@acme.com",
      "janet@acme.com",
    ]);
    expect(findSimilarAccounts("zzz")).toEqual([]);
  });
});

describe("promptForAccount", () => {
  test("uses the type-to-filter picker with the active account highlighted", async () => {
    addAccount("https://sentry.io", { userId: "1", email: "jane@acme.com" });
    const active = addAccount("https://sentry.acme.com", {
      userId: "2",
      email: "jane@corp.dev",
    });
    selectWithFilter.mockResolvedValue(active);

    const picked = await promptForAccount(
      listAccounts(),
      "Switch to which account?",
      "sentry auth switch",
    );

    expect(picked?.id).toBe(active);
    expect(selectWithFilter).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Switch to which account?",
        initialValue: active,
        options: [
          expect.objectContaining({ label: "jane@acme.com on sentry.io" }),
          expect.objectContaining({
            label: "jane@corp.dev on sentry.acme.com",
            hint: "active",
          }),
        ],
      }),
    );
  });

  test("returns undefined when the picker is cancelled", async () => {
    addAccount("https://sentry.io", { userId: "1", email: "jane@acme.com" });
    selectWithFilter.mockResolvedValue(null);

    await expect(
      promptForAccount(listAccounts(), "Pick", "sentry auth switch"),
    ).resolves.toBeUndefined();
  });
});
