/**
 * `sentry auth whoami` reminder of the other stored accounts.
 */

import { describe, expect, test } from "vitest";
import { formatOtherIdentitiesHint } from "../../../src/commands/auth/whoami.js";
import { setAuthToken } from "../../../src/lib/db/auth.js";
import { setUserInfo } from "../../../src/lib/db/user.js";
import { useEnvSandbox, useTestConfigDir } from "../../helpers.js";

useTestConfigDir("auth-whoami-identities-");
useEnvSandbox(["SENTRY_AUTH_TOKEN", "SENTRY_TOKEN", "SENTRY_FORCE_ENV_TOKEN"]);

function login(token: string, host: string, userId: string, email: string) {
  setAuthToken(token, undefined, undefined, { host, newAccount: true });
  setUserInfo({ userId, email });
}

describe("formatOtherIdentitiesHint", () => {
  test("lists the other stored accounts you could be", () => {
    login("work-token", "https://sentry.acme.com", "1", "jane@acme.com");
    login("personal-token", "https://sentry.io", "2", "jane@personal.dev");

    expect(
      formatOtherIdentitiesHint({ id: "2", name: "Jane", email: "x" }),
    ).toBe(
      "You are Jane, but you can be whoever you want — as long as it's one of: " +
        "jane@acme.com on sentry.acme.com. Run 'sentry auth switch'.",
    );
  });

  test("says nothing with a single stored account", () => {
    login("work-token", "https://sentry.io", "1", "jane@acme.com");

    expect(formatOtherIdentitiesHint({ id: "1" })).toBeUndefined();
  });
});
