import { describe, expect, test, vi } from "vitest";
import { ApiError, AuthError } from "../../src/lib/errors.js";
import { OAUTH_SCOPES } from "../../src/lib/oauth.js";
import {
  captureOAuthScopeRecoveryGate,
  ensureCurrentOAuthScopes,
  runWithScopeRecovery,
  type ScopeRecoveryRuntime,
} from "../../src/lib/scope-recovery.js";

function runtime(
  overrides: Partial<ScopeRecoveryRuntime> = {}
): ScopeRecoveryRuntime {
  return {
    assertTrustedHost: vi.fn(),
    getAuthScopes: vi.fn().mockResolvedValue(OAUTH_SCOPES),
    getAuthSource: () => "oauth",
    inputIsTty: () => true,
    promptsAllowed: () => true,
    write: vi.fn(),
    ...overrides,
  };
}

describe("runWithScopeRecovery", () => {
  test("checks the token after a 403, re-authorizes a stale grant, and retries", async () => {
    const error = new ApiError("Forbidden", 403);
    const proceed = vi
      .fn<(argv: string[]) => Promise<void>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce();
    const login = vi.fn().mockResolvedValue({ method: "oauth" });
    const testRuntime = runtime({
      getAuthScopes: vi
        .fn()
        .mockResolvedValue(
          OAUTH_SCOPES.filter((scope) => scope !== "team:admin")
        ),
    });

    await runWithScopeRecovery(
      proceed,
      ["project", "create"],
      login,
      testRuntime
    );

    expect(proceed).toHaveBeenCalledTimes(2);
    expect(testRuntime.getAuthScopes).toHaveBeenCalledOnce();
    expect(testRuntime.assertTrustedHost).toHaveBeenCalledOnce();
    expect(login).toHaveBeenCalledWith();
    expect(testRuntime.write).toHaveBeenCalledWith(
      expect.stringContaining("team:admin")
    );
  });

  test("does not re-authorize a role or policy 403 when the token has every scope", async () => {
    const error = new ApiError("Forbidden", 403);
    const proceed = vi.fn().mockRejectedValue(error);
    const login = vi.fn();

    await expect(
      runWithScopeRecovery(proceed, [], login, runtime())
    ).rejects.toBe(error);

    expect(login).not.toHaveBeenCalled();
  });

  test("re-authorizes after a 401 when the API reports no active token", async () => {
    const error = new ApiError("Unauthorized", 401);
    const proceed = vi
      .fn<(argv: string[]) => Promise<void>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce();
    const login = vi.fn().mockResolvedValue({ method: "oauth" });

    await runWithScopeRecovery(
      proceed,
      [],
      login,
      runtime({ getAuthScopes: vi.fn().mockResolvedValue(null) })
    );

    expect(login).toHaveBeenCalledOnce();
    expect(proceed).toHaveBeenCalledTimes(2);
  });

  test("re-authorizes when scope inspection rejects an invalid token", async () => {
    const error = new ApiError("Unauthorized", 401);
    const proceed = vi
      .fn<(argv: string[]) => Promise<void>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce();
    const login = vi.fn().mockResolvedValue({ method: "oauth" });

    await runWithScopeRecovery(
      proceed,
      [],
      login,
      runtime({
        getAuthScopes: vi
          .fn()
          .mockRejectedValue(new ApiError("Invalid token", 401)),
      })
    );

    expect(login).toHaveBeenCalledOnce();
    expect(proceed).toHaveBeenCalledTimes(2);
  });

  test("re-authorizes when a failed refresh clears the stored OAuth row", async () => {
    const error = new ApiError("Unauthorized", 401);
    const proceed = vi
      .fn<(argv: string[]) => Promise<void>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce();
    const login = vi.fn().mockResolvedValue({ method: "oauth" });
    const getAuthSource = vi
      .fn<() => "oauth" | undefined>()
      .mockReturnValueOnce("oauth")
      .mockReturnValueOnce(undefined);
    const getAuthScopes = vi.fn();

    await runWithScopeRecovery(
      proceed,
      [],
      login,
      runtime({ getAuthSource, getAuthScopes })
    );

    expect(login).toHaveBeenCalledOnce();
    expect(getAuthScopes).not.toHaveBeenCalled();
  });

  test("does not launch OAuth for environment tokens", async () => {
    const error = new ApiError("Forbidden", 403);
    const login = vi.fn();
    const getAuthScopes = vi.fn().mockResolvedValue([]);

    await expect(
      runWithScopeRecovery(
        vi.fn().mockRejectedValue(error),
        [],
        login,
        runtime({
          getAuthSource: () => "env:SENTRY_AUTH_TOKEN",
          getAuthScopes,
        })
      )
    ).rejects.toBe(error);

    expect(login).not.toHaveBeenCalled();
    expect(getAuthScopes).not.toHaveBeenCalled();
  });

  test("checks scopes but does not launch OAuth without an interactive TTY", async () => {
    const error = new ApiError("Forbidden", 403);
    const getAuthScopes = vi.fn().mockResolvedValue([]);
    const login = vi.fn();

    await expect(
      runWithScopeRecovery(
        vi.fn().mockRejectedValue(error),
        [],
        login,
        runtime({ getAuthScopes, inputIsTty: () => false })
      )
    ).rejects.toBe(error);

    expect(getAuthScopes).toHaveBeenCalledOnce();
    expect(login).not.toHaveBeenCalled();
  });

  test("does not launch OAuth when JSON output disables prompts", async () => {
    const error = new ApiError("Forbidden", 403);
    const getAuthScopes = vi.fn().mockResolvedValue([]);
    const login = vi.fn();

    await expect(
      runWithScopeRecovery(
        vi.fn().mockRejectedValue(error),
        ["--json"],
        login,
        runtime({ getAuthScopes, promptsAllowed: () => false })
      )
    ).rejects.toBe(error);

    expect(getAuthScopes).toHaveBeenCalledOnce();
    expect(login).not.toHaveBeenCalled();
  });

  test("preserves the original error when scope inspection fails", async () => {
    const error = new ApiError("Forbidden", 403);
    const login = vi.fn();

    await expect(
      runWithScopeRecovery(
        vi.fn().mockRejectedValue(error),
        [],
        login,
        runtime({
          getAuthScopes: vi.fn().mockRejectedValue(new Error("offline")),
        })
      )
    ).rejects.toBe(error);
    expect(login).not.toHaveBeenCalled();
  });

  test("does not attempt a second recovery when the retry fails", async () => {
    const first = new ApiError("Forbidden", 403);
    const second = new ApiError("Still forbidden", 403);
    const proceed = vi
      .fn<(argv: string[]) => Promise<void>>()
      .mockRejectedValueOnce(first)
      .mockRejectedValueOnce(second);
    const login = vi.fn().mockResolvedValue({ method: "oauth" });

    await expect(
      runWithScopeRecovery(
        proceed,
        [],
        login,
        runtime({ getAuthScopes: vi.fn().mockResolvedValue([]) })
      )
    ).rejects.toBe(second);
    expect(login).toHaveBeenCalledOnce();
    expect(proceed).toHaveBeenCalledTimes(2);
  });
});

describe("scope recovery availability", () => {
  test("only gives init errors to recovery when authorization can run", async () => {
    const error = new ApiError("Forbidden", 403);
    const availableRuntime = runtime({
      getAuthScopes: vi.fn().mockResolvedValue([]),
    });
    expect(
      await captureOAuthScopeRecoveryGate(availableRuntime).shouldDelegate(
        error,
        { unattended: false }
      )
    ).toBe(true);

    const blockedCases = [
      {
        unattended: true,
        runtime: runtime(),
      },
      {
        unattended: false,
        runtime: runtime({ inputIsTty: () => false }),
      },
      {
        unattended: false,
        runtime: runtime({ promptsAllowed: () => false }),
      },
    ];

    for (const blocked of blockedCases) {
      const getAuthScopes = vi.mocked(blocked.runtime.getAuthScopes);
      expect(
        await captureOAuthScopeRecoveryGate(blocked.runtime).shouldDelegate(
          error,
          { unattended: blocked.unattended }
        )
      ).toBe(false);
      expect(getAuthScopes).not.toHaveBeenCalled();
    }
  });

  test("retains OAuth provenance when a failed refresh clears stored auth", async () => {
    const getAuthSource = vi
      .fn<() => "oauth" | undefined>()
      .mockReturnValueOnce("oauth")
      .mockReturnValueOnce(undefined);
    const getAuthScopes = vi.fn();
    const testRuntime = runtime({ getAuthSource, getAuthScopes });
    const scopeRecovery = captureOAuthScopeRecoveryGate(testRuntime);

    expect(
      await scopeRecovery.shouldDelegate(new ApiError("Unauthorized", 401), {
        unattended: false,
      })
    ).toBe(true);
    expect(getAuthScopes).not.toHaveBeenCalled();
  });
});

describe("upgrade scope check", () => {
  test("re-authorizes a stale OAuth grant", async () => {
    const login = vi.fn().mockResolvedValue({ method: "oauth" });
    const refreshed = await ensureCurrentOAuthScopes(
      login,
      runtime({ getAuthScopes: vi.fn().mockResolvedValue(["org:read"]) })
    );

    expect(refreshed).toBe(true);
    expect(login).toHaveBeenCalledOnce();
  });

  test("re-authorizes when the stored token is rejected during upgrade", async () => {
    const login = vi.fn().mockResolvedValue({ method: "oauth" });
    const refreshed = await ensureCurrentOAuthScopes(
      login,
      runtime({
        getAuthScopes: vi
          .fn()
          .mockRejectedValue(new ApiError("Invalid token", 401)),
      })
    );

    expect(refreshed).toBe(true);
    expect(login).toHaveBeenCalledOnce();
  });

  test("re-authorizes when upgrade scope inspection reports expired auth", async () => {
    const login = vi.fn().mockResolvedValue({ method: "oauth" });
    const refreshed = await ensureCurrentOAuthScopes(
      login,
      runtime({
        getAuthScopes: vi.fn().mockRejectedValue(new AuthError("expired")),
      })
    );

    expect(refreshed).toBe(true);
    expect(login).toHaveBeenCalledOnce();
  });

  test("does nothing when the stored grant is current", async () => {
    const login = vi.fn();
    expect(await ensureCurrentOAuthScopes(login, runtime())).toBe(false);
    expect(login).not.toHaveBeenCalled();
  });
});
