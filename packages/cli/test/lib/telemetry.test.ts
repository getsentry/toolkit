/**
 * Telemetry Module Tests
 *
 * Tests for withTelemetry wrapper and opt-out behavior.
 */

import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as Sentry from "@sentry/node-core/light";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { formatAuthHeader } from "../../src/lib/auth-header.js";
import { Database } from "../../src/lib/db/sqlite.js";
import {
  ApiError,
  AuthError,
  MalformedAuthTokenError,
  OutputError,
} from "../../src/lib/errors.js";
import {
  createTracedDatabase,
  createWizardPromptTelemetry,
  getSentryTracePropagationTargets,
  initSentry,
  isEbadfError,
  isEpipeError,
  isUserApiError,
  recordApiErrorOnSpan,
  resetReadonlyWarning,
  setArgsContext,
  setCommandSpanName,
  setFlagContext,
  setOrgProjectContext,
  withDbSpan,
  withFsSpan,
  withHttpSpan,
  withSerializeSpan,
  withTelemetry,
  withTracing,
  withTracingSpan,
} from "../../src/lib/telemetry.js";

// Snapshot beforeExit listeners before any test calls initSentry(true).
// The ProcessSession integration registers an anonymous handler via setupOnce
// that has no cleanup mechanism. After all tests, we remove any listeners
// that weren't present before to prevent the Bun test runner from hanging.
const preTestListeners = new Set(process.rawListeners("beforeExit"));

afterAll(() => {
  for (const listener of process.rawListeners("beforeExit")) {
    if (!preTestListeners.has(listener)) {
      process.removeListener(
        "beforeExit",
        listener as (...args: unknown[]) => void
      );
    }
  }
});

describe("initSentry", () => {
  test("returns client with enabled=false when disabled", () => {
    const client = initSentry(false);
    expect(client?.getOptions().enabled).toBe(false);
  });

  test("returns client with DSN when enabled", () => {
    const client = initSentry(true);
    expect(client?.getOptions().dsn).toBeDefined();
    expect(client?.getOptions().enabled).toBe(true);
  });

  test("derives environment from CLI_VERSION via getCliEnvironment()", () => {
    const client = initSentry(true);
    // In test/dev mode, CLI_VERSION is "0.0.0-dev" → "development"
    expect(client?.getOptions().environment).toBe("development");
  });

  test("uses 0.0.0-dev version when SENTRY_CLI_VERSION is not defined", () => {
    const client = initSentry(true);
    expect(client?.getOptions().release).toBe("0.0.0-dev");
  });
});

describe("withTelemetry", () => {
  const ENV_VAR = "SENTRY_CLI_NO_TELEMETRY";
  let originalEnvValue: string | undefined;

  beforeEach(() => {
    originalEnvValue = process.env[ENV_VAR];
  });

  afterEach(() => {
    if (originalEnvValue === undefined) {
      delete process.env[ENV_VAR];
    } else {
      process.env[ENV_VAR] = originalEnvValue;
    }
  });

  test("executes callback and returns result", async () => {
    const result = await withTelemetry(() => 42);
    expect(result).toBe(42);
  });

  test("handles async callbacks", async () => {
    const result = await withTelemetry(async () => {
      await sleep(1);
      return "async result";
    });
    expect(result).toBe("async result");
  });

  test("propagates errors from callback", async () => {
    await expect(
      withTelemetry(() => {
        throw new Error("test error");
      })
    ).rejects.toThrow("test error");
  });

  test("propagates async errors", async () => {
    await expect(
      withTelemetry(async () => {
        await sleep(1);
        throw new Error("async error");
      })
    ).rejects.toThrow("async error");
  });

  test("handles complex return types", async () => {
    const result = await withTelemetry(() => ({
      status: "ok",
      count: 42,
      items: [1, 2, 3],
    }));
    expect(result).toEqual({ status: "ok", count: 42, items: [1, 2, 3] });
  });

  test("handles void return value", async () => {
    let sideEffect = false;
    const result = await withTelemetry(() => {
      sideEffect = true;
    });
    expect(result).toBeUndefined();
    expect(sideEffect).toBe(true);
  });

  test("handles null return value", async () => {
    const result = await withTelemetry(() => null);
    expect(result).toBeNull();
  });

  test("respects SENTRY_CLI_NO_TELEMETRY=1 env var", async () => {
    process.env[ENV_VAR] = "1";
    let executed = false;
    await withTelemetry(() => {
      executed = true;
    });
    expect(executed).toBe(true);
  });

  test("propagates 4xx ApiError to caller", async () => {
    const error = new ApiError("Not found", 404, "Issue not found");
    await expect(
      withTelemetry(() => {
        throw error;
      })
    ).rejects.toThrow(error);
  });

  describe("with telemetry enabled", () => {
    beforeEach(() => {
      delete process.env[ENV_VAR];
    });

    afterEach(() => {
      // Re-init with enabled=false to reset global SDK state.
      // Without this, Sentry.isEnabled() returns true for all
      // subsequent test files (e.g. feedbackCommand checks it).
      initSentry(false);
    });

    test("propagates 4xx ApiError through enabled SDK path", async () => {
      const error = new ApiError("Not found", 404, "Issue not found");
      await expect(
        withTelemetry(() => {
          throw error;
        })
      ).rejects.toThrow(error);
    });

    test("propagates 5xx ApiError through enabled SDK path", async () => {
      const error = new ApiError("Server error", 500, "Internal error");
      await expect(
        withTelemetry(() => {
          throw error;
        })
      ).rejects.toThrow(error);
    });

    test("propagates generic Error through enabled SDK path", async () => {
      await expect(
        withTelemetry(() => {
          throw new Error("unexpected bug");
        })
      ).rejects.toThrow("unexpected bug");
    });

    test("returns result through enabled SDK path", async () => {
      const result = await withTelemetry(() => 42);
      expect(result).toBe(42);
    });

    test("does not capture OutputError (intentional exit-code mechanism)", async () => {
      const captureSpy = vi.spyOn(Sentry, "captureException");
      const error = new OutputError(null);
      await expect(
        withTelemetry(() => {
          throw error;
        })
      ).rejects.toThrow(error);
      expect(captureSpy).not.toHaveBeenCalled();
      captureSpy.mockRestore();
    });

    test("does not capture OutputError with data", async () => {
      const captureSpy = vi.spyOn(Sentry, "captureException");
      const error = new OutputError({ error: "not found" });
      await expect(
        withTelemetry(() => {
          throw error;
        })
      ).rejects.toThrow(error);
      expect(captureSpy).not.toHaveBeenCalled();
      captureSpy.mockRestore();
    });

    test("emits cli.error.silenced metric for user API errors", async () => {
      const metricSpy = vi.spyOn(Sentry.metrics, "distribution");
      const captureSpy = vi.spyOn(Sentry, "captureException");
      const error = new ApiError(
        "Not found",
        404,
        "detail",
        "/api/0/organizations/foo/"
      );
      await expect(
        withTelemetry(() => {
          throw error;
        })
      ).rejects.toThrow(error);
      // Silenced: no captureException
      expect(captureSpy).not.toHaveBeenCalled();
      // Metric emitted with normalized endpoint attribute
      const silencedCall = metricSpy.mock.calls.find(
        (c) => c[0] === "cli.error.silenced"
      );
      expect(silencedCall).toBeDefined();
      expect(silencedCall?.[2]).toMatchObject({
        attributes: expect.objectContaining({
          error_class: "ApiError",
          reason: "api_user_error",
          api_status: 404,
        }),
      });
      metricSpy.mockRestore();
      captureSpy.mockRestore();
    });

    test("captures 5xx ApiError with fingerprint applied", async () => {
      const captureSpy = vi.spyOn(Sentry, "captureException");
      const withScopeSpy = vi.spyOn(Sentry, "withScope");
      const error = new ApiError(
        "Server error",
        500,
        "Internal",
        "/api/0/organizations/foo/"
      );
      await expect(
        withTelemetry(() => {
          throw error;
        })
      ).rejects.toThrow(error);
      // Captured via reportCliError → Sentry.withScope
      expect(withScopeSpy).toHaveBeenCalled();
      expect(captureSpy).toHaveBeenCalledWith(error);
      withScopeSpy.mockRestore();
      captureSpy.mockRestore();
    });

    test("captures ContextError so its volume stays visible (CLI-3B)", async () => {
      const captureSpy = vi.spyOn(Sentry, "captureException");
      const metricSpy = vi.spyOn(Sentry.metrics, "distribution");
      // Seed an OK session so we can assert the crash decision. ContextError is
      // captured (see below) but is an expected user-context failure, not a CLI
      // crash — marking it crashed would skew release-health for the ~2000
      // affected users, so the session must stay "ok".
      const session = { status: "ok", errors: 0 };
      const isolationScopeSpy = vi
        .spyOn(Sentry, "getIsolationScope")
        .mockReturnValue({
          getSession: () => session,
        } as unknown as Sentry.Scope);
      const currentScopeSpy = vi
        .spyOn(Sentry, "getCurrentScope")
        .mockReturnValue({
          getSession: () => null,
        } as unknown as Sentry.Scope);
      const { ContextError } = await import("../../src/lib/errors.js");
      const error = new ContextError(
        "Organization and project",
        "sentry issue view <org>/<project>/<id>"
      );
      await expect(
        withTelemetry(() => {
          throw error;
        })
      ).rejects.toThrow(error);
      // ContextError is no longer silenced — its volume drives auto-detection
      // and UX improvements, so it must be reported to Sentry.
      expect(captureSpy).toHaveBeenCalled();
      const silencedCall = metricSpy.mock.calls.find(
        (c) => c[0] === "cli.error.silenced"
      );
      expect(silencedCall).toBeUndefined();
      // ...but the session must NOT be marked crashed.
      expect(session.status).toBe("ok");
      captureSpy.mockRestore();
      metricSpy.mockRestore();
      isolationScopeSpy.mockRestore();
      currentScopeSpy.mockRestore();
    });

    test("captures malformed tokens without marking the session crashed", async () => {
      const captureSpy = vi.spyOn(Sentry, "captureException");
      const metricSpy = vi.spyOn(Sentry.metrics, "distribution");
      const session = { status: "ok", errors: 0 };
      const isolationScopeSpy = vi
        .spyOn(Sentry, "getIsolationScope")
        .mockReturnValue({
          getSession: () => session,
        } as unknown as Sentry.Scope);
      const currentScopeSpy = vi
        .spyOn(Sentry, "getCurrentScope")
        .mockReturnValue({
          getSession: () => null,
        } as unknown as Sentry.Scope);
      try {
        await expect(
          withTelemetry(() => formatAuthHeader("first-part\nsecond-part"))
        ).rejects.toThrow(MalformedAuthTokenError);
        expect(captureSpy).toHaveBeenCalledExactlyOnceWith(
          expect.any(MalformedAuthTokenError)
        );
        expect(
          metricSpy.mock.calls.find((c) => c[0] === "cli.error.silenced")
        ).toBeUndefined();
        expect(session.status).toBe("ok");
      } finally {
        captureSpy.mockRestore();
        metricSpy.mockRestore();
        isolationScopeSpy.mockRestore();
        currentScopeSpy.mockRestore();
      }
    });

    test("marks session crashed for a genuine CLI bug", async () => {
      // A generic Error is neither silenced nor a user error, so the session
      // should be marked crashed (the counterpart to the ContextError case).
      const session = { status: "ok", errors: 0 };
      const isolationScopeSpy = vi
        .spyOn(Sentry, "getIsolationScope")
        .mockReturnValue({
          getSession: () => session,
        } as unknown as Sentry.Scope);
      const currentScopeSpy = vi
        .spyOn(Sentry, "getCurrentScope")
        .mockReturnValue({
          getSession: () => null,
        } as unknown as Sentry.Scope);
      const error = new Error("unexpected bug");
      await expect(
        withTelemetry(() => {
          throw error;
        })
      ).rejects.toThrow(error);
      expect(session.status).toBe("crashed");
      isolationScopeSpy.mockRestore();
      currentScopeSpy.mockRestore();
    });

    test("marks session crashed for a 5xx ApiError (captured, non-user)", async () => {
      // A 5xx is captured (not silenced) and is NOT a user error, so it must
      // still mark the session crashed — guards against the isUserError gate
      // accidentally widening to swallow server/CLI failures.
      const session = { status: "ok", errors: 0 };
      const isolationScopeSpy = vi
        .spyOn(Sentry, "getIsolationScope")
        .mockReturnValue({
          getSession: () => session,
        } as unknown as Sentry.Scope);
      const currentScopeSpy = vi
        .spyOn(Sentry, "getCurrentScope")
        .mockReturnValue({
          getSession: () => null,
        } as unknown as Sentry.Scope);
      const error = new ApiError("Server error", 500, "Internal");
      await expect(
        withTelemetry(() => {
          throw error;
        })
      ).rejects.toThrow(error);
      expect(session.status).toBe("crashed");
      isolationScopeSpy.mockRestore();
      currentScopeSpy.mockRestore();
    });

    test("does not mark session crashed for a deliberate CliError", async () => {
      // A bare CliError is a deliberately-thrown, message-carrying failure (the
      // CLI decided to stop and told the user why), not an unexpected crash.
      // isUserError returns true for it, so it must NOT mark the session
      // crashed. On main (before the isUserError gate) this WAS crash-marked, so
      // this test documents and guards the intended behavior change.
      const session = { status: "ok", errors: 0 };
      const isolationScopeSpy = vi
        .spyOn(Sentry, "getIsolationScope")
        .mockReturnValue({
          getSession: () => session,
        } as unknown as Sentry.Scope);
      const currentScopeSpy = vi
        .spyOn(Sentry, "getCurrentScope")
        .mockReturnValue({
          getSession: () => null,
        } as unknown as Sentry.Scope);
      const { CliError } = await import("../../src/lib/errors.js");
      const error = new CliError("Internal error: resolved issue missing org");
      await expect(
        withTelemetry(() => {
          throw error;
        })
      ).rejects.toThrow(error);
      expect(session.status).toBe("ok");
      isolationScopeSpy.mockRestore();
      currentScopeSpy.mockRestore();
    });
  });
});

describe("isUserApiError", () => {
  test("returns false for 400 Bad Request (CLI bug, not user error)", () => {
    expect(isUserApiError(new ApiError("Bad request", 400))).toBe(false);
  });

  test("returns false for a 400 search-query parse error (CLI-built bad query)", () => {
    // A user's unparseable --query is converted to a ValidationError at the
    // command boundary, so a search-query 400 reaching here is a CLI-built bad
    // request — a CLI bug, not a user API error.
    expect(
      isUserApiError(
        new ApiError("bad", 400, "Error parsing search query: invalid status")
      )
    ).toBe(false);
  });

  test("returns true for 401 Unauthorized", () => {
    expect(isUserApiError(new ApiError("Unauthorized", 401))).toBe(true);
  });

  test("returns true for 403 Forbidden", () => {
    expect(isUserApiError(new ApiError("Forbidden", 403, "No access"))).toBe(
      true
    );
  });

  test("returns true for 404 Not Found", () => {
    expect(
      isUserApiError(new ApiError("Not found", 404, "Issue not found"))
    ).toBe(true);
  });

  test("returns true for 429 Too Many Requests", () => {
    expect(isUserApiError(new ApiError("Rate limited", 429))).toBe(true);
  });

  test("returns false for 500 Internal Server Error", () => {
    expect(isUserApiError(new ApiError("Server error", 500))).toBe(false);
  });

  test("returns false for 502 Bad Gateway", () => {
    expect(isUserApiError(new ApiError("Bad gateway", 502))).toBe(false);
  });

  test("returns false for non-ApiError", () => {
    expect(isUserApiError(new Error("generic error"))).toBe(false);
  });

  test("returns false for AuthError", () => {
    expect(isUserApiError(new AuthError("not_authenticated"))).toBe(false);
  });

  test("returns false for null/undefined", () => {
    expect(isUserApiError(null)).toBe(false);
    expect(isUserApiError(undefined)).toBe(false);
  });

  test("returns false for non-Error objects", () => {
    expect(isUserApiError({ status: 404 })).toBe(false);
    expect(isUserApiError("404")).toBe(false);
  });
});

describe("isEpipeError", () => {
  test("detects EPIPE in exception message", () => {
    const event = {
      exception: { values: [{ value: "write EPIPE" }] },
    } as Sentry.ErrorEvent;
    expect(isEpipeError(event)).toBe(true);
  });

  test("detects EPIPE in node_system_error context", () => {
    const event = {
      contexts: { node_system_error: { code: "EPIPE" } },
    } as Sentry.ErrorEvent;
    expect(isEpipeError(event)).toBe(true);
  });

  test("returns false for non-EPIPE errors", () => {
    const event = {
      exception: { values: [{ value: "something else" }] },
    } as Sentry.ErrorEvent;
    expect(isEpipeError(event)).toBe(false);
  });
});

describe("isEbadfError", () => {
  test("detects EBADF in exception message", () => {
    const event = {
      exception: {
        values: [
          { value: "EBADF: bad file descriptor, scandir '//dev/fd/22'" },
        ],
      },
    } as Sentry.ErrorEvent;
    expect(isEbadfError(event)).toBe(true);
  });

  test("detects EBADF in Bun-style message", () => {
    const event = {
      exception: {
        values: [{ value: "EBADF: bad file descriptor, stat '//dev/fd/10'" }],
      },
    } as Sentry.ErrorEvent;
    expect(isEbadfError(event)).toBe(true);
  });

  test("detects EBADF in node_system_error context", () => {
    const event = {
      contexts: { node_system_error: { code: "EBADF" } },
    } as Sentry.ErrorEvent;
    expect(isEbadfError(event)).toBe(true);
  });

  test("returns false for non-EBADF errors", () => {
    const event = {
      exception: { values: [{ value: "EPIPE: broken pipe" }] },
    } as Sentry.ErrorEvent;
    expect(isEbadfError(event)).toBe(false);
  });

  test("returns false for events without exceptions or contexts", () => {
    expect(isEbadfError({} as Sentry.ErrorEvent)).toBe(false);
  });
});

describe("recordApiErrorOnSpan", () => {
  function createMockSpan() {
    const attributes: Record<string, string | number> = {};
    return {
      attributes,
      setAttribute(key: string, value: string | number) {
        attributes[key] = value;
      },
    };
  }

  test("sets status and message attributes", () => {
    const span = createMockSpan();
    const error = new ApiError("Not found", 404);
    recordApiErrorOnSpan(span as never, error);

    expect(span.attributes["api_error.status"]).toBe(404);
    expect(span.attributes["api_error.message"]).toBe("Not found");
    expect(span.attributes["api_error.detail"]).toBeUndefined();
  });

  test("sets detail attribute when present", () => {
    const span = createMockSpan();
    const error = new ApiError("Not found", 404, "Issue not found");
    recordApiErrorOnSpan(span as never, error);

    expect(span.attributes["api_error.status"]).toBe(404);
    expect(span.attributes["api_error.message"]).toBe("Not found");
    expect(span.attributes["api_error.detail"]).toBe("Issue not found");
  });

  test("omits detail attribute when empty string", () => {
    const span = createMockSpan();
    const error = new ApiError("Bad request", 400, "");
    recordApiErrorOnSpan(span as never, error);

    expect(span.attributes["api_error.status"]).toBe(400);
    expect(span.attributes["api_error.detail"]).toBeUndefined();
  });

  test("handles different 4xx status codes", () => {
    const span = createMockSpan();
    const error = new ApiError("Forbidden", 403, "No access");
    recordApiErrorOnSpan(span as never, error);

    expect(span.attributes["api_error.status"]).toBe(403);
    expect(span.attributes["api_error.message"]).toBe("Forbidden");
    expect(span.attributes["api_error.detail"]).toBe("No access");
  });
});

describe("setCommandSpanName", () => {
  test("handles undefined span gracefully", () => {
    // Should not throw when span is undefined
    expect(() => setCommandSpanName(undefined, "test.command")).not.toThrow();
  });
});

describe("setOrgProjectContext", () => {
  test("handles empty arrays", () => {
    expect(() => setOrgProjectContext([], [])).not.toThrow();
  });

  test("handles single org/project", () => {
    expect(() =>
      setOrgProjectContext(["my-org"], ["my-project"])
    ).not.toThrow();
  });

  test("handles multiple orgs/projects", () => {
    expect(() =>
      setOrgProjectContext(["org1", "org2"], ["proj1", "proj2"])
    ).not.toThrow();
  });
});

describe("setFlagContext", () => {
  let setTagSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setTagSpy = vi.spyOn(Sentry, "setTag");
  });

  afterEach(() => {
    setTagSpy.mockRestore();
  });

  test("does not set tags for empty flags object", () => {
    setFlagContext({});
    expect(setTagSpy).not.toHaveBeenCalled();
  });

  test("sets tags for boolean flags when true", () => {
    setFlagContext({ verbose: true, debug: true });
    expect(setTagSpy).toHaveBeenCalledTimes(2);
    expect(setTagSpy).toHaveBeenCalledWith("flag.verbose", "true");
    expect(setTagSpy).toHaveBeenCalledWith("flag.debug", "true");
  });

  test("does not set tags for boolean flags when false", () => {
    setFlagContext({ verbose: false, debug: false });
    expect(setTagSpy).not.toHaveBeenCalled();
  });

  test("sets tags for string flags with values", () => {
    setFlagContext({ output: "json", format: "table" });
    expect(setTagSpy).toHaveBeenCalledTimes(2);
    expect(setTagSpy).toHaveBeenCalledWith("flag.output", "json");
    expect(setTagSpy).toHaveBeenCalledWith("flag.format", "table");
  });

  test("sets tags for number flags", () => {
    setFlagContext({ limit: 10, offset: 5 });
    expect(setTagSpy).toHaveBeenCalledTimes(2);
    expect(setTagSpy).toHaveBeenCalledWith("flag.limit", "10");
    expect(setTagSpy).toHaveBeenCalledWith("flag.offset", "5");
  });

  test("does not set tags for undefined or null values", () => {
    setFlagContext({ value: undefined, other: null });
    expect(setTagSpy).not.toHaveBeenCalled();
  });

  test("does not set tags for empty string values", () => {
    setFlagContext({ name: "" });
    expect(setTagSpy).not.toHaveBeenCalled();
  });

  test("does not set tags for empty array values", () => {
    setFlagContext({ items: [] });
    expect(setTagSpy).not.toHaveBeenCalled();
  });

  test("sets tags for non-empty array values", () => {
    setFlagContext({ projects: ["proj1", "proj2"] });
    expect(setTagSpy).toHaveBeenCalledTimes(1);
    expect(setTagSpy).toHaveBeenCalledWith("flag.projects", "proj1,proj2");
  });

  test("only sets tags for meaningful values in mixed flags", () => {
    setFlagContext({
      verbose: true,
      quiet: false,
      limit: 50,
      output: "json",
      projects: ["a", "b"],
      empty: "",
      missing: undefined,
    });
    // Should set: verbose, limit, output, projects (4 tags)
    // Should skip: quiet (false), empty (""), missing (undefined)
    expect(setTagSpy).toHaveBeenCalledTimes(4);
    expect(setTagSpy).toHaveBeenCalledWith("flag.verbose", "true");
    expect(setTagSpy).toHaveBeenCalledWith("flag.limit", "50");
    expect(setTagSpy).toHaveBeenCalledWith("flag.output", "json");
    expect(setTagSpy).toHaveBeenCalledWith("flag.projects", "a,b");
  });

  test("converts camelCase to kebab-case", () => {
    setFlagContext({
      noModifyPath: true,
      someVeryLongFlagName: "value",
    });
    expect(setTagSpy).toHaveBeenCalledTimes(2);
    expect(setTagSpy).toHaveBeenCalledWith("flag.no-modify-path", "true");
    expect(setTagSpy).toHaveBeenCalledWith(
      "flag.some-very-long-flag-name",
      "value"
    );
  });

  test("truncates long string values to 200 characters", () => {
    const longValue = "x".repeat(250);
    setFlagContext({ longFlag: longValue });
    expect(setTagSpy).toHaveBeenCalledTimes(1);
    expect(setTagSpy).toHaveBeenCalledWith("flag.long-flag", "x".repeat(200));
  });

  test("redacts sensitive flag values (token)", () => {
    setFlagContext({
      token: "sntrys_eyJpYXQiOjE3MDAwMDAwMDAsImF1dGhUb2tlbiI6InNlY3JldCJ9",
    });
    expect(setTagSpy).toHaveBeenCalledTimes(1);
    expect(setTagSpy).toHaveBeenCalledWith("flag.token", "[REDACTED]");
  });

  test("still sets the tag when token flag is present (presence is useful signal)", () => {
    setFlagContext({ token: "any-token-value" });
    // The tag is set (so we know --token was used), but the value is redacted
    expect(setTagSpy).toHaveBeenCalledWith("flag.token", "[REDACTED]");
  });

  test("does not redact non-sensitive flags alongside token", () => {
    setFlagContext({ token: "secret", format: "json" });
    expect(setTagSpy).toHaveBeenCalledTimes(2);
    expect(setTagSpy).toHaveBeenCalledWith("flag.token", "[REDACTED]");
    expect(setTagSpy).toHaveBeenCalledWith("flag.format", "json");
  });
});

describe("setArgsContext", () => {
  let setContextSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setContextSpy = vi.spyOn(Sentry, "setContext");
  });

  afterEach(() => {
    setContextSpy.mockRestore();
  });

  test("does not set context for empty args", () => {
    setArgsContext([]);
    expect(setContextSpy).not.toHaveBeenCalled();
  });

  test("sets context for string args", () => {
    setArgsContext(["PROJECT-123", "my-org"]);
    expect(setContextSpy).toHaveBeenCalledTimes(1);
    expect(setContextSpy).toHaveBeenCalledWith("args", {
      values: ["PROJECT-123", "my-org"],
      count: 2,
    });
  });

  test("converts non-string args to JSON", () => {
    setArgsContext([123, { key: "value" }]);
    expect(setContextSpy).toHaveBeenCalledWith("args", {
      values: ["123", '{"key":"value"}'],
      count: 2,
    });
  });
});

describe("withHttpSpan", () => {
  test("executes function and returns result", async () => {
    const result = await withHttpSpan("GET", "/test", async () => "success");
    expect(result).toBe("success");
  });

  test("propagates errors", async () => {
    await expect(
      withHttpSpan("POST", "/test", async () => {
        throw new Error("http error");
      })
    ).rejects.toThrow("http error");
  });
});

describe("withDbSpan", () => {
  test("executes function and returns result", () => {
    const result = withDbSpan("testOp", () => 42);
    expect(result).toBe(42);
  });

  test("propagates errors", () => {
    expect(() =>
      withDbSpan("testOp", () => {
        throw new Error("db error");
      })
    ).toThrow("db error");
  });
});

describe("withSerializeSpan", () => {
  test("executes function and returns result", () => {
    const result = withSerializeSpan("format", () => ({ formatted: true }));
    expect(result).toEqual({ formatted: true });
  });

  test("propagates errors", () => {
    expect(() =>
      withSerializeSpan("format", () => {
        throw new Error("serialize error");
      })
    ).toThrow("serialize error");
  });
});

describe("withTracing", () => {
  test("executes sync function and returns result", async () => {
    const result = await withTracing("test", "test.op", () => 42);
    expect(result).toBe(42);
  });

  test("executes async function and returns result", async () => {
    const result = await withTracing("test", "test.op", async () => {
      await sleep(1);
      return "async result";
    });
    expect(result).toBe("async result");
  });

  test("propagates sync errors", async () => {
    await expect(
      withTracing("test", "test.op", () => {
        throw new Error("sync error");
      })
    ).rejects.toThrow("sync error");
  });

  test("propagates async errors", async () => {
    await expect(
      withTracing("test", "test.op", async () => {
        await sleep(1);
        throw new Error("async error");
      })
    ).rejects.toThrow("async error");
  });

  test("handles complex return types", async () => {
    const result = await withTracing("test", "test.op", () => ({
      status: "ok",
      items: [1, 2, 3],
    }));
    expect(result).toEqual({ status: "ok", items: [1, 2, 3] });
  });

  test("accepts attributes", async () => {
    // This test mainly verifies the call doesn't throw
    const result = await withTracing("test", "test.op", () => "success", {
      "test.attr": "value",
      "test.count": 42,
    });
    expect(result).toBe("success");
  });
});

describe("withFsSpan", () => {
  test("executes sync function and returns result", async () => {
    const result = await withFsSpan("readFile", () => "file content");
    expect(result).toBe("file content");
  });

  test("executes async function and returns result", async () => {
    const result = await withFsSpan("readFile", async () => {
      await sleep(1);
      return "async content";
    });
    expect(result).toBe("async content");
  });

  test("propagates errors", async () => {
    await expect(
      withFsSpan("readFile", () => {
        throw new Error("fs error");
      })
    ).rejects.toThrow("fs error");
  });
});

describe("withTracingSpan", () => {
  test("passes span to callback", async () => {
    let receivedSpan: unknown = null;
    await withTracingSpan("test", "test.op", (span) => {
      receivedSpan = span;
      return "done";
    });
    expect(receivedSpan).not.toBeNull();
  });

  test("executes async function and returns result", async () => {
    const result = await withTracingSpan("test", "test.op", async () => {
      await sleep(1);
      return "async result";
    });
    expect(result).toBe("async result");
  });

  test("propagates errors", async () => {
    await expect(
      withTracingSpan("test", "test.op", () => {
        throw new Error("test error");
      })
    ).rejects.toThrow("test error");
  });

  test("allows callback to set attributes", async () => {
    // This test verifies the span is usable for setting attributes
    const result = await withTracingSpan("test", "test.op", (span) => {
      span.setAttribute("custom.attr", "value");
      span.setAttributes({ "batch.attr1": 1, "batch.attr2": "two" });
      return "success";
    });
    expect(result).toBe("success");
  });

  test("allows callback to set status without being overridden", async () => {
    // Callback sets error status but returns successfully
    // withTracingSpan should not override the manually-set status
    const result = await withTracingSpan("test", "test.op", (span) => {
      span.setStatus({ code: 2, message: "Manual error" });
      return "returned despite error status";
    });
    expect(result).toBe("returned despite error status");
  });

  test("accepts initial attributes", async () => {
    const result = await withTracingSpan("test", "test.op", () => "success", {
      "init.attr": "initial",
    });
    expect(result).toBe("success");
  });
});

describe("createWizardPromptTelemetry", () => {
  test("records individual prompt waits and accumulates root wait time", async () => {
    const setMeasurementSpy = vi.spyOn(Sentry, "setMeasurement");
    const metricSpy = vi.spyOn(Sentry.metrics, "distribution");
    let now = 100;
    const performanceSpy = vi
      .spyOn(globalThis.performance, "now")
      .mockImplementation(() => now);
    const telemetry = createWizardPromptTelemetry();

    telemetry.setActiveStep("select-features", true);
    const firstResult = await telemetry.tracePrompt("multiselect", async () => {
      now = 125;
      return ["errorMonitoring"];
    });
    telemetry.setActiveStep("select-features", false);
    const secondResult = await telemetry.tracePrompt("confirm", async () => {
      now = 140;
      return true;
    });

    expect(firstResult).toEqual(["errorMonitoring"]);
    expect(secondResult).toBe(true);
    expect(setMeasurementSpy).toHaveBeenNthCalledWith(
      1,
      "wizard.user_wait_ms",
      25,
      "millisecond",
      expect.anything()
    );
    expect(setMeasurementSpy).toHaveBeenNthCalledWith(
      2,
      "wizard.user_wait_ms",
      40,
      "millisecond",
      expect.anything()
    );
    expect(metricSpy).toHaveBeenCalledWith("wizard.user_wait_ms", 25, {
      attributes: {
        prompt_kind: "multiselect",
        workflow_step: "select-features",
      },
    });
    expect(metricSpy).toHaveBeenCalledWith("wizard.user_wait_ms", 15, {
      attributes: { prompt_kind: "confirm" },
    });

    performanceSpy.mockRestore();
    metricSpy.mockRestore();
    setMeasurementSpy.mockRestore();
  });
});

describe("createTracedDatabase", () => {
  test("wraps database and traces query().get()", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)");
    db.exec("INSERT INTO test (id, name) VALUES (1, 'Alice')");

    const tracedDb = createTracedDatabase(db);
    const row = tracedDb.query("SELECT * FROM test WHERE id = ?").get(1) as {
      id: number;
      name: string;
    };

    expect(row).toEqual({ id: 1, name: "Alice" });
    db.close();
  });

  test("wraps database and traces query().all()", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)");
    db.exec("INSERT INTO test (id, name) VALUES (1, 'Alice'), (2, 'Bob')");

    const tracedDb = createTracedDatabase(db);
    const rows = tracedDb.query("SELECT * FROM test ORDER BY id").all() as {
      id: number;
      name: string;
    }[];

    expect(rows).toEqual([
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ]);
    db.close();
  });

  test("wraps database and traces query().run()", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)");

    const tracedDb = createTracedDatabase(db);
    tracedDb.query("INSERT INTO test (id, name) VALUES (?, ?)").run(1, "Alice");

    const row = db.query("SELECT * FROM test WHERE id = 1").get() as {
      id: number;
      name: string;
    };
    expect(row).toEqual({ id: 1, name: "Alice" });
    db.close();
  });

  test("passes through non-query methods like exec", () => {
    const db = new Database(":memory:");
    const tracedDb = createTracedDatabase(db);

    // exec should work without tracing (passes through proxy)
    tracedDb.exec("CREATE TABLE test (id INTEGER)");
    tracedDb.exec("INSERT INTO test VALUES (1)");

    const row = tracedDb.query("SELECT * FROM test").get() as { id: number };
    expect(row).toEqual({ id: 1 });
    db.close();
  });

  test("passes through close method", () => {
    const db = new Database(":memory:");
    const tracedDb = createTracedDatabase(db);

    // Should not throw
    expect(() => tracedDb.close()).not.toThrow();
  });

  test("propagates errors from queries", () => {
    const db = new Database(":memory:");
    const tracedDb = createTracedDatabase(db);

    expect(() => {
      tracedDb.query("SELECT * FROM nonexistent_table").get();
    }).toThrow();

    db.close();
  });

  test("statement non-execution methods pass through", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE test (id INTEGER, name TEXT)");
    const tracedDb = createTracedDatabase(db);

    const stmt = tracedDb.query("SELECT * FROM test WHERE id = ?");

    // columnNames is bun:sqlite-specific; skip assertion on Node.js
    if ("columnNames" in stmt) {
      expect(stmt.columnNames).toEqual(["id", "name"]);
    }
    expect(typeof stmt.toString).toBe("function");

    db.close();
  });

  test("statement methods are properly bound for native calls", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE test (id INTEGER, name TEXT)");
    const tracedDb = createTracedDatabase(db);

    const stmt = tracedDb.query("SELECT * FROM test WHERE id = ?");

    // toString() requires proper 'this' binding to access native private fields.
    // bun:sqlite returns the SQL string; Node.js sqlite returns "[object Object]".
    const sqlString = stmt.toString();
    if (sqlString !== "[object Object]") {
      expect(sqlString).toContain("SELECT * FROM test");
    }

    // finalize() is bun:sqlite-specific; skip on Node.js
    if (typeof stmt.finalize === "function") {
      expect(() => stmt.finalize()).not.toThrow();
    }

    db.close();
  });

  describe("readonly database handling", () => {
    let tmpDir: string;
    let dbPath: string;

    beforeEach(() => {
      resetReadonlyWarning();

      tmpDir = `${import.meta.dirname}/tmp-readonly-${Date.now()}`;
      mkdirSync(tmpDir, { recursive: true });
      dbPath = `${tmpDir}/test.db`;

      const setupDb = new Database(dbPath);
      setupDb.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)");
      setupDb.exec("INSERT INTO test (id, name) VALUES (1, 'Alice')");
      setupDb.close();

      chmodSync(dbPath, 0o444);
    });

    afterEach(() => {
      try {
        chmodSync(dbPath, 0o644);
      } catch {
        // May already be cleaned up
      }
      rmSync(tmpDir, { recursive: true, force: true });
    });

    test("does not throw on write to readonly database", () => {
      // bun:sqlite opens the file successfully — the error only surfaces on write
      const db = new Database(dbPath);
      const tracedDb = createTracedDatabase(db);

      expect(() => {
        tracedDb
          .query("INSERT INTO test (id, name) VALUES (?, ?)")
          .run(2, "Bob");
      }).not.toThrow();

      db.close();
    });

    test("reads still work on readonly database", () => {
      const db = new Database(dbPath);
      const tracedDb = createTracedDatabase(db);

      const row = tracedDb.query("SELECT * FROM test WHERE id = ?").get(1) as {
        id: number;
        name: string;
      };
      expect(row).toEqual({ id: 1, name: "Alice" });

      db.close();
    });

    test("all() and values() return empty arrays on readonly write", () => {
      const db = new Database(dbPath);
      const tracedDb = createTracedDatabase(db);

      const allResult = tracedDb
        .query("INSERT INTO test (id, name) VALUES (?, ?)")
        .all(2, "Bob");
      expect(allResult).toEqual([]);

      // values() is bun:sqlite-specific; skip on Node.js
      const stmt = tracedDb.query("INSERT INTO test (id, name) VALUES (?, ?)");
      if (typeof stmt.values === "function") {
        const valuesResult = stmt.values(3, "Charlie");
        expect(valuesResult).toEqual([]);
      }

      db.close();
    });

    test("shows readonly warning when auto-repair fails", () => {
      // Mock chmodSync to always throw, simulating a file owned by another user.
      // This makes tryRepairReadonly fail and fall through to warnReadonlyDatabaseOnce.
      const fs = require("node:fs");
      const chmodSpy = vi.spyOn(fs, "chmodSync").mockImplementation(() => {
        throw Object.assign(new Error("EPERM: operation not permitted"), {
          code: "EPERM",
        });
      });

      const db = new Database(dbPath);
      const tracedDb = createTracedDatabase(db);

      const stderrSpy = vi.spyOn(process.stderr, "write");

      tracedDb.query("INSERT INTO test (id, name) VALUES (?, ?)").run(2, "Bob");

      const output = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      // When repair fails, the warning message should appear instead
      expect(output).toContain("read-only");
      expect(output).toContain("sentry cli fix");

      stderrSpy.mockRestore();
      chmodSpy.mockRestore();
      db.close();
    });
  });
});

describe("getSentryTracePropagationTargets", () => {
  const SENTRY_URL_ENV = "SENTRY_URL";
  const SENTRY_HOST_ENV = "SENTRY_HOST";
  let originalSentryUrl: string | undefined;
  let originalSentryHost: string | undefined;

  beforeEach(() => {
    originalSentryUrl = process.env[SENTRY_URL_ENV];
    originalSentryHost = process.env[SENTRY_HOST_ENV];
    delete process.env[SENTRY_URL_ENV];
    delete process.env[SENTRY_HOST_ENV];
  });

  afterEach(() => {
    if (originalSentryUrl === undefined) {
      delete process.env[SENTRY_URL_ENV];
    } else {
      process.env[SENTRY_URL_ENV] = originalSentryUrl;
    }
    if (originalSentryHost === undefined) {
      delete process.env[SENTRY_HOST_ENV];
    } else {
      process.env[SENTRY_HOST_ENV] = originalSentryHost;
    }
  });

  test("matches SaaS regional URLs", () => {
    const targets = getSentryTracePropagationTargets();
    const regexTargets = targets.filter(
      (t): t is RegExp => t instanceof RegExp
    );
    expect(
      regexTargets.some((r) => r.test("https://us.sentry.io/api/0/"))
    ).toBe(true);
    expect(
      regexTargets.some((r) => r.test("https://de.sentry.io/api/0/"))
    ).toBe(true);
    expect(
      regexTargets.some((r) =>
        r.test("https://o1234.ingest.us.sentry.io/api/0/")
      )
    ).toBe(true);
  });

  test("matches bare sentry.io", () => {
    const targets = getSentryTracePropagationTargets();
    const regexTargets = targets.filter(
      (t): t is RegExp => t instanceof RegExp
    );
    expect(regexTargets.some((r) => r.test("https://sentry.io/api/0/"))).toBe(
      true
    );
  });

  test("does not match non-sentry URLs", () => {
    const targets = getSentryTracePropagationTargets();
    const regexTargets = targets.filter(
      (t): t is RegExp => t instanceof RegExp
    );
    expect(regexTargets.some((r) => r.test("https://example.com/api/0/"))).toBe(
      false
    );
    expect(
      regexTargets.some((r) => r.test("https://not-sentry.io/api/0/"))
    ).toBe(false);
  });

  test("does not match domains beyond sentry.io TLD boundary", () => {
    const targets = getSentryTracePropagationTargets();
    const regexTargets = targets.filter(
      (t): t is RegExp => t instanceof RegExp
    );
    // sentry.io.evil.com should NOT match
    expect(
      regexTargets.some((r) => r.test("https://sentry.io.evil.com/api/0/"))
    ).toBe(false);
    // us.sentry.io.evil.com should NOT match
    expect(
      regexTargets.some((r) => r.test("https://us.sentry.io.evil.com/api/0/"))
    ).toBe(false);
  });

  test("includes self-hosted URL when configured", () => {
    process.env[SENTRY_URL_ENV] = "https://sentry.mycompany.com";
    const targets = getSentryTracePropagationTargets();
    const stringTargets = targets.filter(
      (t): t is string => typeof t === "string"
    );
    expect(stringTargets).toContain("https://sentry.mycompany.com");
  });

  test("does not include SaaS URL as string target", () => {
    // Default (no SENTRY_URL) → only RegExp targets, no string targets
    const targets = getSentryTracePropagationTargets();
    const stringTargets = targets.filter(
      (t): t is string => typeof t === "string"
    );
    expect(stringTargets).toHaveLength(0);
  });

  test("does not duplicate SaaS URL when SENTRY_URL is sentry.io", () => {
    process.env[SENTRY_URL_ENV] = "https://sentry.io";
    const targets = getSentryTracePropagationTargets();
    // SaaS URLs are already covered by regex — no string target should be added
    const stringTargets = targets.filter(
      (t): t is string => typeof t === "string"
    );
    expect(stringTargets).toHaveLength(0);
  });
});
