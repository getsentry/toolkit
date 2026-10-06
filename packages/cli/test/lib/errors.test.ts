import { describe, expect, test } from "vitest";
import {
  AbortError,
  ApiError,
  AuthError,
  buildValidationMessage,
  CliError,
  ConfigError,
  ContextError,
  DeviceFlowError,
  EXIT,
  formatError,
  getExitCode,
  HostScopeError,
  isNetworkError,
  isSearchQueryParseError,
  isUserError,
  OutputError,
  ResolutionError,
  SeerError,
  stringifyUnknown,
  TimeoutError,
  toSearchQueryError,
  UpgradeError,
  ValidationError,
  validationError,
  WizardError,
  withAuthGuard,
} from "../../src/lib/errors.js";

describe("CliError", () => {
  test("has default exit code of EXIT.GENERAL", () => {
    const err = new CliError("Something went wrong");
    expect(err.exitCode).toBe(EXIT.GENERAL);
    expect(err.message).toBe("Something went wrong");
  });

  test("accepts custom exit code", () => {
    const err = new CliError("Custom exit", 42);
    expect(err.exitCode).toBe(42);
  });

  test("format() returns message", () => {
    const err = new CliError("Test message");
    expect(err.format()).toBe("Test message");
  });
});

describe("AuthError", () => {
  test("not_authenticated has default message", () => {
    const err = new AuthError("not_authenticated");
    expect(err.message).toBe(
      "Not authenticated. Run 'sentry auth login' first."
    );
    expect(err.reason).toBe("not_authenticated");
  });

  test("expired has default message", () => {
    const err = new AuthError("expired");
    expect(err.message).toBe(
      "Authentication expired. Run 'sentry auth login' to re-authenticate."
    );
    expect(err.reason).toBe("expired");
  });

  test("invalid has default message", () => {
    const err = new AuthError("invalid");
    expect(err.message).toBe("Invalid authentication token.");
  });

  test("accepts custom message", () => {
    const err = new AuthError("not_authenticated", "Custom auth error");
    expect(err.message).toBe("Custom auth error");
    expect(err.reason).toBe("not_authenticated");
  });
});

describe("ApiError", () => {
  test("stores status and detail", () => {
    const err = new ApiError("Request failed", 404, "Not found", "/api/issues");
    expect(err.status).toBe(404);
    expect(err.detail).toBe("Not found");
    expect(err.endpoint).toBe("/api/issues");
  });

  test("format() includes detail on separate line", () => {
    const err = new ApiError("Request failed", 500, "Internal server error");
    expect(err.format()).toBe("Request failed\n  Internal server error");
  });

  test("format() excludes detail if same as message", () => {
    const err = new ApiError("Same message", 500, "Same message");
    expect(err.format()).toBe("Same message");
  });

  test("format() works without detail", () => {
    const err = new ApiError("Request failed", 503);
    expect(err.format()).toBe("Request failed");
  });
});

describe("ConfigError", () => {
  test("format() includes suggestion", () => {
    const err = new ConfigError("Invalid config", "Check the config file");
    expect(err.format()).toBe(
      "Invalid config\n\nSuggestion: Check the config file"
    );
  });

  test("format() works without suggestion", () => {
    const err = new ConfigError("Invalid config");
    expect(err.format()).toBe("Invalid config");
  });
});

describe("ContextError", () => {
  test("format() uses auto-detect headline when alternatives omitted", () => {
    const err = new ContextError("Organization", "sentry org list");
    const formatted = err.format();
    expect(formatted).toContain("Could not auto-detect organization.");
    expect(formatted).toContain("Provide it explicitly:");
    expect(formatted).toContain("sentry org list");
    expect(formatted).toContain(
      "Run from a directory with a Sentry DSN in source code or .env files"
    );
    expect(formatted).toContain(
      "Set SENTRY_ORG and SENTRY_PROJECT (or SENTRY_DSN) environment variables"
    );
  });

  test("format() includes custom alternatives", () => {
    const err = new ContextError("Project", "sentry project list", [
      "Specify project in <org>/<project> format",
    ]);
    const formatted = err.format();
    expect(formatted).toContain("Project is required.");
    expect(formatted).toContain("Specify project in <org>/<project> format");
    expect(formatted).not.toContain("SENTRY_DSN");
  });

  test("format() works with empty alternatives", () => {
    const err = new ContextError("Resource", "sentry resource get", []);
    const formatted = err.format();
    expect(formatted).toContain("Resource is required.");
    expect(formatted).not.toContain("Or:");
  });

  test("format() includes note section after alternatives", () => {
    const err = new ContextError(
      "Organization",
      "sentry org list",
      undefined,
      "Found 2 DSN(s) that could not be resolved"
    );
    const formatted = err.format();
    expect(formatted).toContain("Could not auto-detect organization.");
    // Default alternatives are present
    expect(formatted).toContain("Or:");
    expect(formatted).toContain(
      "Run from a directory with a Sentry DSN in source code or .env files"
    );
    // Note appears as a separate section
    expect(formatted).toContain(
      "Note: Found 2 DSN(s) that could not be resolved"
    );
    // Note appears after alternatives
    const orIndex = formatted.indexOf("Or:");
    const noteIndex = formatted.indexOf("Note:");
    expect(noteIndex).toBeGreaterThan(orIndex);
  });

  test("format() includes note without alternatives", () => {
    const err = new ContextError(
      "Resource",
      "sentry resource get",
      [],
      "Some diagnostic info"
    );
    const formatted = err.format();
    expect(formatted).toContain("Resource is required.");
    expect(formatted).not.toContain("Or:");
    expect(formatted).toContain("Note: Some diagnostic info");
  });

  test("note field is stored on instance", () => {
    const err = new ContextError(
      "Organization",
      "sentry org list",
      undefined,
      "test note"
    );
    expect(err.note).toBe("test note");
  });
});

describe("ResolutionError", () => {
  test("format() includes 'not found' headline and Try hint", () => {
    const err = new ResolutionError(
      "Issue 99124558",
      "not found",
      "sentry issue view <org>/99124558",
      [
        "No issue with numeric ID 99124558 found",
        "If this is a short ID suffix, try: sentry issue view <project>-99124558",
      ]
    );
    const formatted = err.format();
    expect(formatted).toContain("Issue 99124558 not found.");
    expect(formatted).toContain("Try:");
    expect(formatted).toContain("sentry issue view <org>/99124558");
    expect(formatted).toContain("No issue with numeric ID 99124558 found");
    expect(formatted).toContain("short ID suffix");
    // Should NOT say "is required"
    expect(formatted).not.toContain("is required");
  });

  test("format() works with 'is ambiguous' headline", () => {
    const err = new ResolutionError(
      "Project 'cli'",
      "is ambiguous",
      "sentry issue view <org>/cli-G",
      ["Found in: sentry, acme"]
    );
    const formatted = err.format();
    expect(formatted).toContain("Project 'cli' is ambiguous.");
    expect(formatted).toContain("Try:");
    expect(formatted).toContain("Or:");
    expect(formatted).toContain("Found in: sentry, acme");
  });

  test("format() works with empty suggestions (no Or: section)", () => {
    const err = new ResolutionError(
      'Event abc123 in organization "acme"',
      "not found",
      "sentry event view acme/<project> abc123"
    );
    const formatted = err.format();
    expect(formatted).toContain(
      'Event abc123 in organization "acme" not found.'
    );
    expect(formatted).toContain("Try:");
    expect(formatted).not.toContain("Or:");
  });

  test("stores resource, headline, hint, and suggestions", () => {
    const err = new ResolutionError(
      "Issue suffix 'G'",
      "could not be resolved without project context",
      "sentry issue view <org>/<project>-G"
    );
    expect(err.resource).toBe("Issue suffix 'G'");
    expect(err.headline).toBe("could not be resolved without project context");
    expect(err.hint).toBe("sentry issue view <org>/<project>-G");
    expect(err.suggestions).toEqual([]);
  });

  test("is a CliError subclass", () => {
    const err = new ResolutionError(
      "Issue 1",
      "not found",
      "sentry issue view 1"
    );
    expect(err).toBeInstanceOf(CliError);
    expect(err.name).toBe("ResolutionError");
    expect(err.exitCode).toBe(EXIT.RESOLUTION);
  });
});

describe("ValidationError", () => {
  test("stores field name", () => {
    const err = new ValidationError("Invalid format", "email");
    expect(err.field).toBe("email");
    expect(err.message).toBe("Invalid format");
  });

  test("field is optional", () => {
    const err = new ValidationError("Invalid input");
    expect(err.field).toBeUndefined();
  });
});

describe("buildValidationMessage", () => {
  test("formats Try examples and Note section", () => {
    expect(
      buildValidationMessage(
        "Invalid flag.",
        ["sentry release set-commits 1.0.0 --from v0.9.0"],
        "Range is always <ref>..HEAD."
      )
    ).toBe(
      [
        "Invalid flag.",
        "",
        "Try:",
        "  sentry release set-commits 1.0.0 --from v0.9.0",
        "",
        "Note: Range is always <ref>..HEAD.",
      ].join("\n")
    );
  });

  test("validationError wrapper preserves field", () => {
    const err = validationError("Bad ref.", ["git rev-parse v0.9.0"], "from");
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.field).toBe("from");
    expect(err.message).toContain("Try:");
  });
});

describe("DeviceFlowError", () => {
  test("stores error code", () => {
    const err = new DeviceFlowError("slow_down", "Polling too fast");
    expect(err.code).toBe("slow_down");
    expect(err.message).toBe("Polling too fast");
  });

  test("uses code as message if no description", () => {
    const err = new DeviceFlowError("authorization_pending");
    expect(err.message).toBe("authorization_pending");
  });
});

describe("UpgradeError", () => {
  test("unknown_method has default message", () => {
    const err = new UpgradeError("unknown_method");
    expect(err.message).toBe(
      "Could not detect installation method. Use --method to specify."
    );
    expect(err.reason).toBe("unknown_method");
  });

  test("network_error has default message", () => {
    const err = new UpgradeError("network_error");
    expect(err.message).toBe("Failed to fetch version information.");
    expect(err.reason).toBe("network_error");
  });

  test("execution_failed has default message", () => {
    const err = new UpgradeError("execution_failed");
    expect(err.message).toBe("Upgrade command failed.");
    expect(err.reason).toBe("execution_failed");
  });

  test("version_not_found has default message", () => {
    const err = new UpgradeError("version_not_found");
    expect(err.message).toBe("The specified version was not found.");
    expect(err.reason).toBe("version_not_found");
  });

  test("accepts custom message", () => {
    const err = new UpgradeError("network_error", "Custom upgrade error");
    expect(err.message).toBe("Custom upgrade error");
    expect(err.reason).toBe("network_error");
  });
});

describe("SeerError", () => {
  test("not_enabled has default message", () => {
    const err = new SeerError("not_enabled");
    expect(err.message).toBe("Seer is not enabled for this organization.");
    expect(err.reason).toBe("not_enabled");
  });

  test("no_budget has default message", () => {
    const err = new SeerError("no_budget");
    expect(err.message).toBe("Seer requires a paid plan.");
    expect(err.reason).toBe("no_budget");
  });

  test("ai_disabled has default message", () => {
    const err = new SeerError("ai_disabled");
    expect(err.message).toBe("AI features are disabled for this organization.");
    expect(err.reason).toBe("ai_disabled");
  });

  test("format() includes settings URL when orgSlug provided", () => {
    const err = new SeerError("not_enabled", "my-org");
    const formatted = err.format();
    expect(formatted).toContain("Seer is not enabled for this organization.");
    expect(formatted).toContain("To enable Seer:");
    expect(formatted).toContain("my-org");
  });

  test("format() includes billing URL for no_budget with orgSlug", () => {
    const err = new SeerError("no_budget", "my-org");
    const formatted = err.format();
    expect(formatted).toContain("Seer requires a paid plan.");
    expect(formatted).toContain("upgrade your plan");
    expect(formatted).toContain("my-org");
  });

  test("format() includes org settings URL for ai_disabled with orgSlug", () => {
    const err = new SeerError("ai_disabled", "my-org");
    const formatted = err.format();
    expect(formatted).toContain("AI features are disabled");
    expect(formatted).toContain("To enable AI features:");
    expect(formatted).toContain("my-org");
  });

  test("format() shows fallback message without orgSlug", () => {
    const err = new SeerError("not_enabled");
    const formatted = err.format();
    expect(formatted).toContain("Seer is not enabled for this organization.");
    expect(formatted).toContain("visit your organization's Seer settings");
  });

  test("format() shows fallback for no_budget without orgSlug", () => {
    const err = new SeerError("no_budget");
    const formatted = err.format();
    expect(formatted).toContain(
      "upgrade your plan in your organization's billing settings"
    );
  });

  test("format() shows fallback for ai_disabled without orgSlug", () => {
    const err = new SeerError("ai_disabled");
    const formatted = err.format();
    expect(formatted).toContain("Hide AI Features");
  });
});

describe("stringifyUnknown", () => {
  test("returns strings as-is", () => {
    expect(stringifyUnknown("hello")).toBe("hello");
    expect(stringifyUnknown("")).toBe("");
  });

  test("extracts message from Error instances", () => {
    expect(stringifyUnknown(new Error("something broke"))).toBe(
      "something broke"
    );
    expect(stringifyUnknown(new TypeError("bad type"))).toBe("bad type");
  });

  test("serializes plain objects to JSON", () => {
    expect(stringifyUnknown({ code: "not_found" })).toBe(
      '{"code":"not_found"}'
    );
    expect(stringifyUnknown({ detail: { message: "Forbidden" } })).toBe(
      '{"detail":{"message":"Forbidden"}}'
    );
  });

  test("serializes empty objects", () => {
    expect(stringifyUnknown({})).toBe("{}");
  });

  test("serializes arrays to JSON", () => {
    expect(stringifyUnknown(["error1", "error2"])).toBe('["error1","error2"]');
  });

  test("converts primitives via String()", () => {
    expect(stringifyUnknown(42)).toBe("42");
    expect(stringifyUnknown(null)).toBe("null");
    expect(stringifyUnknown(undefined)).toBe("undefined");
    expect(stringifyUnknown(true)).toBe("true");
    expect(stringifyUnknown(0)).toBe("0");
  });

  test("falls back to String() for circular references", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    // Should not throw — falls back to String() which returns [object Object]
    expect(() => stringifyUnknown(circular)).not.toThrow();
    expect(stringifyUnknown(circular)).toBe("[object Object]");
  });

  test("falls back to String() for BigInt values", () => {
    const obj = { count: BigInt(42) };
    // JSON.stringify throws on BigInt — should fall back gracefully
    expect(() => stringifyUnknown(obj)).not.toThrow();
    expect(stringifyUnknown(obj)).toBe("[object Object]");
  });
});

describe("formatError", () => {
  test("uses format() for CliError subclasses", () => {
    const err = new ApiError("API failed", 500, "Server error");
    expect(formatError(err)).toBe("API failed\n  Server error");
  });

  test("uses message for standard Error", () => {
    const err = new Error("Standard error");
    expect(formatError(err)).toBe("Standard error");
  });

  test("converts non-errors to string", () => {
    expect(formatError("string error")).toBe("string error");
    expect(formatError(42)).toBe("42");
    expect(formatError(null)).toBe("null");
    expect(formatError(undefined)).toBe("undefined");
  });

  test("serializes plain objects instead of [object Object]", () => {
    expect(formatError({ code: "not_found" })).toBe('{"code":"not_found"}');
    expect(formatError({})).toBe("{}");
  });
});

describe("getExitCode", () => {
  test("returns exitCode for CliError", () => {
    const err = new CliError("Error", 5);
    expect(getExitCode(err)).toBe(5);
  });

  test("returns 1 for standard Error", () => {
    expect(getExitCode(new Error("test"))).toBe(1);
  });

  test("returns 1 for non-errors", () => {
    expect(getExitCode("string")).toBe(1);
    expect(getExitCode(null)).toBe(1);
  });
});

describe("isUserError", () => {
  test.each([
    ["generic CliError", new CliError("message"), true],
    ["HostScopeError", new HostScopeError("blocked"), true],
    ["AuthError", new AuthError("invalid"), true],
    ["ConfigError", new ConfigError("bad config"), true],
    ["OutputError", new OutputError({ error: "not found" }), true],
    ["ContextError", new ContextError("Organization", "sentry org list"), true],
    [
      "ResolutionError",
      new ResolutionError("Project 'x'", "not found", "sentry project list"),
      true,
    ],
    ["ValidationError", new ValidationError("bad input"), true],
    ["DeviceFlowError", new DeviceFlowError("slow_down"), true],
    ["SeerError", new SeerError("not_enabled"), true],
    ["WizardError", new WizardError("wizard failed"), true],
    ["ApiError 0 (network)", new ApiError("network error", 0), true],
    [
      "raw fetch failed TypeError (network)",
      new TypeError("fetch failed"),
      true,
    ],
    ["ApiError 400", new ApiError("bad request", 400), false],
    [
      // A user's unparseable --query becomes a ValidationError at the command
      // boundary (toSearchQueryError); a raw search-query 400 reaching here is
      // a CLI-built bad request — a CLI bug, not a user error.
      "ApiError 400 (search query parse)",
      new ApiError("bad", 400, "Error parsing search query: invalid status"),
      false,
    ],
    ["ApiError 401", new ApiError("unauthorized", 401), true],
    ["ApiError 418", new ApiError("teapot", 418), true],
    ["ApiError 499", new ApiError("client closed", 499), true],
    ["ApiError 500", new ApiError("server error", 500), false],
    ["TimeoutError", new TimeoutError("timed out"), false],
    ["UpgradeError", new UpgradeError("network_error"), false],
    ["AbortError", new AbortError(), false],
    ["standard Error", new Error("boom"), false],
    ["string throw", "boom", false],
    ["null", null, false],
  ])("classifies %s", (_label, errorValue, expected) => {
    expect(isUserError(errorValue)).toBe(expected);
  });
});

describe("isNetworkError", () => {
  test("true for a raw 'fetch failed' TypeError (undici network failure)", () => {
    expect(isNetworkError(new TypeError("fetch failed"))).toBe(true);
  });

  test("false for ApiError status 0 (shared with TLS cert errors)", () => {
    // status 0 is also used for TLS cert errors, which must stay actionable.
    expect(isNetworkError(new ApiError("Network error", 0))).toBe(false);
    expect(isNetworkError(new ApiError("TLS certificate error", 0))).toBe(
      false
    );
  });

  test("false for an ApiError with an HTTP status", () => {
    expect(isNetworkError(new ApiError("bad", 400))).toBe(false);
    expect(isNetworkError(new ApiError("server", 500))).toBe(false);
  });

  test("false for an unrelated TypeError", () => {
    expect(isNetworkError(new TypeError("x is not a function"))).toBe(false);
  });

  test("false for non-error values", () => {
    expect(isNetworkError(new Error("boom"))).toBe(false);
    expect(isNetworkError("fetch failed")).toBe(false);
    expect(isNetworkError(null)).toBe(false);
  });
});

describe("isSearchQueryParseError", () => {
  test("true for a 400 whose detail reports an unparseable query", () => {
    expect(
      isSearchQueryParseError(
        new ApiError("bad", 400, "Error parsing search query: invalid status")
      )
    ).toBe(true);
  });

  test("true when the parser detail is prepended by error enrichment", () => {
    const detail =
      "Error parsing search query: Empty string after 'status:'\n\nSuggestions:";
    expect(isSearchQueryParseError(new ApiError("wrapped", 400, detail))).toBe(
      true
    );
  });

  test("false for a 400 without a query parse detail", () => {
    expect(
      isSearchQueryParseError(new ApiError("bad", 400, "Other failure"))
    ).toBe(false);
    expect(isSearchQueryParseError(new ApiError("no detail", 400))).toBe(false);
  });

  test("false when status is not 400 (other 4xx handled elsewhere)", () => {
    expect(
      isSearchQueryParseError(
        new ApiError("x", 422, "Error parsing search query: ...")
      )
    ).toBe(false);
  });
});

describe("toSearchQueryError", () => {
  const parseError = () =>
    new ApiError(
      "Failed to fetch issues",
      400,
      "Error parsing search query: bad"
    );

  test("converts a parse 400 to a ValidationError when the user supplied --query", () => {
    const result = toSearchQueryError(parseError(), "is:403");
    expect(result).toBeInstanceOf(ValidationError);
    expect((result as ValidationError).field).toBe("query");
  });

  test("includes the server detail and a search-syntax suggestion in the message", () => {
    const result = toSearchQueryError(
      parseError(),
      "is:403"
    ) as ValidationError;
    expect(result.message).toContain("Error parsing search query: bad");
    expect(result.message).toContain("Sentry search reference");
  });

  test("appends command-specific extra suggestions", () => {
    const result = toSearchQueryError(parseError(), "is:403", [
      "Try a shorter time range",
    ]) as ValidationError;
    expect(result.message).toContain("Try a shorter time range");
  });

  test("returns the original error untouched when the user supplied no --query", () => {
    // No user query → the CLI built the bad query → keep it a reported 400.
    const error = parseError();
    expect(toSearchQueryError(error, undefined)).toBe(error);
    expect(toSearchQueryError(error, "")).toBe(error);
  });

  test("returns the original error for non-search-query 400s", () => {
    const error = new ApiError("bad", 400, "Invalid widget configuration");
    expect(toSearchQueryError(error, "is:403")).toBe(error);
  });

  test("returns the original error for non-ApiError values", () => {
    const error = new Error("boom");
    expect(toSearchQueryError(error, "is:403")).toBe(error);
  });
});

describe("exit codes", () => {
  test("CliError base defaults to EXIT.GENERAL (1)", () => {
    expect(new CliError("err").exitCode).toBe(EXIT.GENERAL);
  });

  test("AuthError maps reasons to exit codes", () => {
    expect(new AuthError("not_authenticated").exitCode).toBe(
      EXIT.AUTH_NOT_AUTHENTICATED
    );
    expect(new AuthError("expired").exitCode).toBe(EXIT.AUTH_EXPIRED);
    expect(new AuthError("invalid").exitCode).toBe(EXIT.AUTH_INVALID);
  });

  test("HostScopeError has exit code AUTH_HOST_SCOPE", () => {
    // Freeform message form
    expect(new HostScopeError("blocked").exitCode).toBe(EXIT.AUTH_HOST_SCOPE);
    // URL mismatch form (no tokenHost)
    expect(
      new HostScopeError("Request", "https://other.sentry.io").exitCode
    ).toBe(EXIT.AUTH_HOST_SCOPE);
    // URL mismatch form (with tokenHost)
    expect(
      new HostScopeError(
        "Request",
        "https://other.sentry.io",
        "https://sentry.io"
      ).exitCode
    ).toBe(EXIT.AUTH_HOST_SCOPE);
  });

  test("ApiError has exit code API", () => {
    expect(new ApiError("fail", 500).exitCode).toBe(EXIT.API);
  });

  test("ConfigError has exit code CONFIG", () => {
    expect(new ConfigError("bad config").exitCode).toBe(EXIT.CONFIG);
  });

  test("ValidationError has exit code VALIDATION", () => {
    expect(new ValidationError("bad input").exitCode).toBe(EXIT.VALIDATION);
  });

  test("ContextError has exit code CONTEXT_MISSING", () => {
    expect(new ContextError("Organization", "sentry org list").exitCode).toBe(
      EXIT.CONTEXT_MISSING
    );
  });

  test("ResolutionError has exit code RESOLUTION", () => {
    expect(
      new ResolutionError("X", "not found", "sentry x view").exitCode
    ).toBe(EXIT.RESOLUTION);
  });

  test("DeviceFlowError has exit code DEVICE_FLOW", () => {
    expect(new DeviceFlowError("slow_down").exitCode).toBe(EXIT.DEVICE_FLOW);
  });

  test("UpgradeError has exit code UPGRADE", () => {
    expect(new UpgradeError("network_error").exitCode).toBe(EXIT.UPGRADE);
  });

  test("SeerError maps reasons to exit codes", () => {
    expect(new SeerError("not_enabled").exitCode).toBe(EXIT.SEER_NOT_ENABLED);
    expect(new SeerError("no_budget").exitCode).toBe(EXIT.SEER_NO_BUDGET);
    expect(new SeerError("ai_disabled").exitCode).toBe(EXIT.SEER_AI_DISABLED);
  });

  test("TimeoutError has exit code TIMEOUT", () => {
    expect(new TimeoutError("timed out").exitCode).toBe(EXIT.TIMEOUT);
  });

  test("OutputError has exit code OUTPUT_ERROR", () => {
    expect(new OutputError({ items: [] }).exitCode).toBe(EXIT.OUTPUT_ERROR);
  });

  test("WizardError defaults to exit code WIZARD", () => {
    expect(new WizardError("wizard failed").exitCode).toBe(EXIT.WIZARD);
  });

  test("WizardError accepts custom exit code for workflow sub-codes", () => {
    expect(
      new WizardError("deps failed", { exitCode: EXIT.WIZARD_DEPS }).exitCode
    ).toBe(EXIT.WIZARD_DEPS);
    expect(
      new WizardError("codemod failed", { exitCode: EXIT.WIZARD_CODEMOD })
        .exitCode
    ).toBe(EXIT.WIZARD_CODEMOD);
    expect(
      new WizardError("verify stopped", { exitCode: EXIT.WIZARD_VERIFY })
        .exitCode
    ).toBe(EXIT.WIZARD_VERIFY);
  });

  test("EXIT values are all unique", () => {
    const values = Object.values(EXIT);
    expect(new Set(values).size).toBe(values.length);
  });

  test("EXIT values are all positive integers below 128", () => {
    for (const [, code] of Object.entries(EXIT)) {
      expect(code).toBeGreaterThan(0);
      expect(code).toBeLessThan(128);
      expect(Number.isInteger(code)).toBe(true);
    }
  });
});

describe("withAuthGuard", () => {
  test("returns ok result on success", async () => {
    const result = await withAuthGuard(() => Promise.resolve("hello"));
    expect(result).toEqual({ ok: true, value: "hello" });
  });

  test("rethrows AuthError('not_authenticated')", async () => {
    await expect(
      withAuthGuard(() => Promise.reject(new AuthError("not_authenticated")))
    ).rejects.toBeInstanceOf(AuthError);
  });

  test("rethrows AuthError('expired')", async () => {
    await expect(
      withAuthGuard(() => Promise.reject(new AuthError("expired")))
    ).rejects.toBeInstanceOf(AuthError);
  });

  test("rethrows AuthError('invalid')", async () => {
    await expect(
      withAuthGuard(() => Promise.reject(new AuthError("invalid")))
    ).rejects.toBeInstanceOf(AuthError);
  });

  test("returns failure result with error on non-AuthError", async () => {
    const thrownError = new Error("network error");
    const result = await withAuthGuard(() => Promise.reject(thrownError));
    expect(result).toEqual({ ok: false, error: thrownError });
  });

  test("returns failure result on ApiError", async () => {
    const apiError = new ApiError("Not found", 404);
    const result = await withAuthGuard(() => Promise.reject(apiError));
    expect(result).toEqual({ ok: false, error: apiError });
  });

  test("preserves the original error object in failure result", async () => {
    const thrownError = new Error("boom");
    const result = await withAuthGuard(() => Promise.reject(thrownError));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(thrownError);
    }
  });

  test("handles non-Error thrown values", async () => {
    const result = await withAuthGuard(() => Promise.reject("string error"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("string error");
    }
  });
});
