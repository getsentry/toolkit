/**
 * Unit tests for the central error reporting helper.
 *
 * Covers:
 * - Silencing rules (OutputError / expected AuthError / 401–499 ApiError)
 * - Grouping tag extraction (extractResourceKind)
 * - Tag enrichment in beforeSend (enrichEventWithGroupingTags)
 * - End-to-end behavior of reportCliError (metric emission + capture)
 */

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as Sentry from "@sentry/node-core/light";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { formatAuthHeader } from "../../src/lib/auth-header.js";
import {
  classifySilenced,
  enrichEventWithGroupingTags,
  extractMessagePrefix,
  extractResourceKind,
  normalizeEndpoint,
  reportCliError,
} from "../../src/lib/error-reporting.js";
import {
  ApiError,
  AuthError,
  CliError,
  ConfigError,
  ContextError,
  HostScopeError,
  MalformedAuthTokenError,
  OutputError,
  ResolutionError,
  SeerError,
  ValidationError,
  WizardError,
} from "../../src/lib/errors.js";

// ---------------------------------------------------------------------------
// extractResourceKind
// ---------------------------------------------------------------------------

describe("extractResourceKind", () => {
  test("strips single-quoted user data", () => {
    expect(
      extractResourceKind("Project 'api-track' not found in organization 'foo'")
    ).toBe("Project not found");
  });

  test("strips double-quoted user data", () => {
    expect(extractResourceKind('Event "abc123" not found in org "foo"')).toBe(
      "Event not found"
    );
  });

  test("strips long hex IDs", () => {
    expect(
      extractResourceKind("Trace abcdef0123456789abcdef0123456789 not found")
    ).toBe("Trace not found");
  });

  test("strips long numeric IDs", () => {
    expect(extractResourceKind("Issue 7420431306 not found.")).toBe(
      "Issue not found."
    );
  });

  test("strips small numeric IDs", () => {
    expect(extractResourceKind("Issue 19 not found.")).toBe("Issue not found.");
    expect(extractResourceKind("Issue 11 not found.")).toBe("Issue not found.");
  });

  test("strips org/project paths after 'in'", () => {
    expect(extractResourceKind("not found in neurio/installer-app")).toBe(
      "not found"
    );
    expect(extractResourceKind("not found in olli-inc/olli-app")).toBe(
      "not found"
    );
    expect(extractResourceKind("access denied in sentry-sdks/cli")).toBe(
      "access denied"
    );
  });

  test("strips 'in <slug>' without org/project slash", () => {
    expect(extractResourceKind("not found in organization")).toBe("not found");
    expect(extractResourceKind("not found in my-org")).toBe("not found");
  });

  test("strips bare slugs after known entity names", () => {
    expect(extractResourceKind("Organization my-company")).toBe("Organization");
    expect(extractResourceKind("Dashboard my-dash-123")).toBe("Dashboard");
    expect(extractResourceKind("Dashboards in my-org")).toBe("Dashboards");
    expect(extractResourceKind("Team backend-team")).toBe("Team");
  });

  test("strips 'in <slug>' combined with entity names and numeric IDs", () => {
    expect(extractResourceKind("Dashboard 42 in my-org")).toBe("Dashboard");
    expect(
      extractResourceKind("Organization my-org not found or has no dashboards")
    ).toBe("Organization not found or has no dashboards");
  });

  test("handles empty input", () => {
    expect(extractResourceKind("")).toBe("");
  });

  test("collapses whitespace introduced by strips", () => {
    expect(extractResourceKind("Issue    suffix    'X'")).toBe("Issue suffix");
  });
});

// ---------------------------------------------------------------------------
// extractMessagePrefix
// ---------------------------------------------------------------------------

describe("extractMessagePrefix", () => {
  test("returns first 3 words by default", () => {
    expect(
      extractMessagePrefix('Invalid trace ID "abc". Expected a 32-character.')
    ).toBe("Invalid trace ID");
  });

  test("strips quoted substrings before word-counting", () => {
    // Quoted input doesn't push the real content past the word limit.
    expect(extractMessagePrefix('Invalid event ID "anything"')).toBe(
      "Invalid event ID"
    );
  });

  test("stops at first newline", () => {
    expect(
      extractMessagePrefix("Invalid slug.\n\nTry: sentry project create")
    ).toBe("Invalid slug.");
  });

  test("returns '' for empty input", () => {
    expect(extractMessagePrefix("")).toBe("");
  });

  test("respects custom maxWords", () => {
    expect(extractMessagePrefix("one two three four five", 2)).toBe("one two");
  });

  test("same kind across different user-supplied values", () => {
    // Invariant: slug variation should not change the kind
    expect(extractMessagePrefix('Invalid trace ID "abc"')).toBe(
      extractMessagePrefix('Invalid trace ID "def"')
    );
  });
});

// ---------------------------------------------------------------------------
// normalizeEndpoint
// ---------------------------------------------------------------------------

describe("normalizeEndpoint", () => {
  test("parameterizes org slug in organizations path", () => {
    expect(normalizeEndpoint("/api/0/organizations/my-org/issues/")).toBe(
      "/api/0/organizations/{org}/issues/"
    );
  });

  test("parameterizes org and project in projects path", () => {
    expect(
      normalizeEndpoint("/api/0/projects/my-org/my-project/events/abc123/")
    ).toBe("/api/0/projects/{org}/{project}/events/{id}/");
  });

  test("parameterizes issue, event, group, release IDs", () => {
    expect(normalizeEndpoint("/api/0/issues/12345/")).toBe(
      "/api/0/issues/{id}/"
    );
    expect(normalizeEndpoint("/api/0/groups/99/events/abc/")).toBe(
      "/api/0/groups/{id}/events/{id}/"
    );
    expect(normalizeEndpoint("/api/0/releases/1.0.0/")).toBe(
      "/api/0/releases/{version}/"
    );
  });

  test("parameterizes teams path", () => {
    expect(normalizeEndpoint("/api/0/teams/my-org/backend/")).toBe(
      "/api/0/teams/{org}/{team}/"
    );
  });

  test("parameterizes dashboards path", () => {
    expect(normalizeEndpoint("/api/0/dashboards/42/")).toBe(
      "/api/0/dashboards/{id}/"
    );
  });

  test("parameterizes customers path", () => {
    expect(normalizeEndpoint("/api/0/customers/my-org/")).toBe(
      "/api/0/customers/{org}/"
    );
  });

  test("parameterizes bare numeric segments", () => {
    expect(normalizeEndpoint("/api/0/some/123/thing/456")).toBe(
      "/api/0/some/{id}/thing/{id}"
    );
  });

  test("leaves paths without variable segments unchanged", () => {
    expect(normalizeEndpoint("/api/0/auth/")).toBe("/api/0/auth/");
  });
});

// ---------------------------------------------------------------------------
// classifySilenced
// ---------------------------------------------------------------------------

describe("classifySilenced", () => {
  test("silences OutputError", () => {
    expect(classifySilenced(new OutputError(null))).toBe("output_error");
  });

  test("silences AuthError(not_authenticated)", () => {
    expect(classifySilenced(new AuthError("not_authenticated"))).toBe(
      "auth_expected"
    );
  });

  test("silences AuthError(expired)", () => {
    expect(classifySilenced(new AuthError("expired"))).toBe("auth_expected");
  });

  test("silences AuthError(invalid)", () => {
    // Rejected credentials stay silenced; malformed tokens use a subclass.
    expect(classifySilenced(new AuthError("invalid"))).toBe("auth_expected");
  });

  test("does NOT silence MalformedAuthTokenError", () => {
    expect(classifySilenced(new MalformedAuthTokenError())).toBeNull();
  });

  test.each([
    401, 403, 404, 429, 418,
  ])("silences ApiError with status %i", (status) => {
    expect(classifySilenced(new ApiError("x", status))).toBe("api_user_error");
  });

  test("does NOT silence ApiError 400 (CLI bug)", () => {
    expect(classifySilenced(new ApiError("bad", 400))).toBeNull();
  });

  test("silences a raw 'fetch failed' TypeError (network failure)", () => {
    expect(classifySilenced(new TypeError("fetch failed"))).toBe(
      "network_error"
    );
  });

  test("does NOT silence a TLS cert error wrapped as ApiError(0)", () => {
    // status 0 is shared by network failures and TLS cert errors; the latter
    // are actionable (missing CA) and must stay captured.
    expect(
      classifySilenced(new ApiError("TLS certificate error", 0))
    ).toBeNull();
  });

  test("does NOT silence an unrelated TypeError", () => {
    expect(classifySilenced(new TypeError("x is not a function"))).toBeNull();
  });

  test("does NOT silence a raw ApiError 400 with a search-query parse detail", () => {
    // A user's unparseable --query is converted to a ValidationError at the
    // command boundary (toSearchQueryError). A search-query 400 reaching the
    // classifier therefore means the CLI built a bad query itself — a real bug
    // that must stay reported (CLI-FA: stop papering over root causes).
    expect(
      classifySilenced(
        new ApiError(
          "Failed to list issues: 400 Bad Request",
          400,
          "Error parsing search query: invalid status value of '403'"
        )
      )
    ).toBeNull();
  });

  test("does NOT silence any 400 regardless of detail", () => {
    expect(
      classifySilenced(
        new ApiError("bad", 400, "Invalid dashboard widget configuration")
      )
    ).toBeNull();
    expect(classifySilenced(new ApiError("bad", 400))).toBeNull();
  });

  test.each([
    500, 502, 503,
  ])("does NOT silence ApiError with 5xx status %i", (status) => {
    expect(classifySilenced(new ApiError("x", status))).toBeNull();
  });

  test.each([
    ["auto-detect failure", new ContextError("Organization and project", "x")],
    ["missing ID", new ContextError("Event ID", "sentry event view <id>", [])],
  ])("does NOT silence ContextError (%s)", (_label, err) => {
    // ContextError volume is the signal driving auto-detection/UX fixes
    // (single-org auto-select, interactive picker), so it must stay captured.
    expect(classifySilenced(err)).toBeNull();
  });

  test("silences ValidationError with field 'project.ambiguous_org'", () => {
    // A project slug that exists in multiple orgs is user-input ambiguity, not
    // a CLI bug. Silence it so it doesn't pollute the issue tracker.
    expect(
      classifySilenced(
        new ValidationError(
          'Project "webapp-backend" exists in multiple organizations.',
          "project.ambiguous_org"
        )
      )
    ).toBe("user_validation");
  });

  test("silences ValidationError with field 'input' (--input file not found)", () => {
    // A missing --input file is pure user-input noise, not a CLI bug (CLI-1JY).
    expect(
      classifySilenced(
        new ValidationError("File not found: /tmp/does-not-exist.json", "input")
      )
    ).toBe("user_input_error");
  });

  test("silences ResolutionError (user provided a value that wasn't found)", () => {
    expect(
      classifySilenced(
        new ResolutionError("Project 'x'", "not found", "sentry issue list")
      )
    ).toBe("user_input_error");
  });
  test.each([
    ["ValidationError (no field)", new ValidationError("bad")],
    [
      "ValidationError (other field)",
      new ValidationError("Invalid trace ID", "trace_id"),
    ],
    ["SeerError", new SeerError("not_enabled")],
    ["ConfigError", new ConfigError("bad")],
    ["generic Error", new Error("boom")],
  ])("does NOT silence %s", (_label, err) => {
    expect(classifySilenced(err)).toBeNull();
  });

  test.each([
    "not_enabled",
    "no_budget",
    "ai_disabled",
  ] as const)("silences SeerError(%s) on self-hosted (CLI-1WP)", (reason) => {
    withSentryUrl("https://sentry.example.com", () => {
      expect(classifySilenced(new SeerError(reason, "my-org"))).toBe(
        "seer_unavailable_self_hosted"
      );
    });
  });

  test("does NOT silence SeerError when SENTRY_URL points at SaaS", () => {
    withSentryUrl("https://sentry.io", () => {
      expect(classifySilenced(new SeerError("not_enabled"))).toBeNull();
    });
  });
});

/**
 * Run `fn` with `SENTRY_URL` set to `url`, restoring the previous value after.
 * `SENTRY_HOST` is cleared for the duration since it takes precedence.
 */
function withSentryUrl(url: string, fn: () => void): void {
  const savedUrl = process.env.SENTRY_URL;
  const savedHost = process.env.SENTRY_HOST;
  process.env.SENTRY_URL = url;
  delete process.env.SENTRY_HOST;
  try {
    fn();
  } finally {
    if (savedUrl === undefined) {
      delete process.env.SENTRY_URL;
    } else {
      process.env.SENTRY_URL = savedUrl;
    }
    if (savedHost !== undefined) {
      process.env.SENTRY_HOST = savedHost;
    }
  }
}

// ---------------------------------------------------------------------------
// enrichEventWithGroupingTags
// ---------------------------------------------------------------------------

describe("enrichEventWithGroupingTags", () => {
  function makeEvent(
    type: string,
    tags?: Record<string, string>
  ): Sentry.ErrorEvent {
    return {
      exception: { values: [{ type, value: "msg" }] },
      ...(tags && { tags }),
    } as Sentry.ErrorEvent;
  }

  test("sets cli_error.class from exception type", () => {
    const event = makeEvent("ContextError");
    const result = enrichEventWithGroupingTags(event);
    expect(result.tags?.["cli_error.class"]).toBe("ContextError");
  });

  test("skips events that already have cli_error.class", () => {
    const event = makeEvent("ContextError", {
      "cli_error.class": "ContextError",
      "cli_error.kind": "Organization",
    });
    const result = enrichEventWithGroupingTags(event);
    expect(result.tags?.["cli_error.kind"]).toBe("Organization");
  });

  test("skips events without exception", () => {
    const event = {} as Sentry.ErrorEvent;
    const result = enrichEventWithGroupingTags(event);
    expect(result.tags).toBeUndefined();
  });

  test("skips events without exception type", () => {
    const event = {
      exception: { values: [{ value: "msg" }] },
    } as Sentry.ErrorEvent;
    const result = enrichEventWithGroupingTags(event);
    expect(result.tags).toBeUndefined();
  });

  test("sets cli_error.kind from exception value", () => {
    const event = makeEvent("TypeError");
    event.exception!.values![0]!.value =
      "Cannot read properties of undefined (reading 'replaceAll')";
    const result = enrichEventWithGroupingTags(event);
    expect(result.tags?.["cli_error.kind"]).toBe("Cannot read properties of");
  });

  test("sets cli_error.kind for fetch failed TypeError", () => {
    const event = makeEvent("TypeError");
    event.exception!.values![0]!.value = "fetch failed";
    const result = enrichEventWithGroupingTags(event);
    expect(result.tags?.["cli_error.kind"]).toBe("fetch failed");
  });

  test("sets cli_error.kind for Error with variable project count", () => {
    const event1 = makeEvent("Error");
    event1.exception!.values![0]!.value =
      "Failed to fetch issues from 3 project(s): Failed to list issues: 400 Bad Request";
    const event2 = makeEvent("Error");
    event2.exception!.values![0]!.value =
      "Failed to fetch issues from 1 project(s): Failed to list issues: 400 Bad Request";
    const result1 = enrichEventWithGroupingTags(event1);
    const result2 = enrichEventWithGroupingTags(event2);
    expect(result1.tags?.["cli_error.kind"]).toBe(
      result2.tags?.["cli_error.kind"]
    );
  });

  test("does not set cli_error.kind when value is missing", () => {
    const event = {
      exception: { values: [{ type: "Error" }] },
    } as Sentry.ErrorEvent;
    const result = enrichEventWithGroupingTags(event);
    expect(result.tags?.["cli_error.class"]).toBe("Error");
    expect(result.tags?.["cli_error.kind"]).toBeUndefined();
  });

  test("does not override existing tags from reportCliError", () => {
    const event = makeEvent("ContextError", {
      "cli_error.class": "ContextError",
      "cli_error.kind": "Organization",
    });
    event.exception!.values![0]!.value = "some different message";
    const result = enrichEventWithGroupingTags(event);
    expect(result.tags?.["cli_error.kind"]).toBe("Organization");
  });
});

// ---------------------------------------------------------------------------
// reportCliError integration
// ---------------------------------------------------------------------------

describe("reportCliError integration", () => {
  let captureSpy: ReturnType<typeof spyOn>;
  let metricSpy: ReturnType<typeof spyOn>;
  let withScopeSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    captureSpy = vi.spyOn(Sentry, "captureException");
    metricSpy = vi.spyOn(Sentry.metrics, "distribution");
    withScopeSpy = vi.spyOn(Sentry, "withScope");
  });

  afterEach(() => {
    captureSpy.mockRestore();
    metricSpy.mockRestore();
    withScopeSpy.mockRestore();
  });

  /**
   * Capture the tags that `reportCliError` would set on the scope.
   * Intercepts `Sentry.withScope` and runs the callback with a fake scope
   * that records `setTag`/`setContext` calls.
   */
  function capturedScopeTags(error: unknown): {
    tags: Record<string, string>;
    contexts: Record<string, unknown>;
  } {
    const tags: Record<string, string> = {};
    const contexts: Record<string, unknown> = {};
    const fakeScope = {
      setTag(k: string, v: string) {
        tags[k] = v;
      },
      setContext(k: string, v: unknown) {
        contexts[k] = v;
      },
      setFingerprint() {
        /* noop */
      },
    };
    withScopeSpy.mockImplementation((fn: (s: unknown) => void) => {
      fn(fakeScope);
    });
    reportCliError(error);
    return { tags, contexts };
  }

  test("captures ContextError (no longer silenced) so its volume stays visible", () => {
    reportCliError(
      new ContextError("Organization and project", "sentry org view <slug>")
    );
    // CLI-3B: ContextError is the signal for auto-detection/UX improvements, so
    // it is captured rather than dropped to a silenced-metric.
    expect(captureSpy).toHaveBeenCalled();
    expect(metricSpy).not.toHaveBeenCalledWith(
      "cli.error.silenced",
      1,
      expect.objectContaining({
        attributes: expect.objectContaining({ error_class: "ContextError" }),
      })
    );
  });

  test("ValidationError with field uses field as kind", () => {
    const { tags } = capturedScopeTags(new ValidationError("Bad", "trace_id"));
    expect(tags["cli_error.class"]).toBe("ValidationError");
    expect(tags["cli_error.kind"]).toBe("trace_id");
  });

  test("ValidationError without field falls back to message prefix", () => {
    // Without a stable fallback, every unfielded ValidationError would get
    // kind="" and collapse into one huge mixed group.
    const err = new ValidationError(
      'Invalid trace ID "d2ad4a2d947b5983". Expected 32-char hex.'
    );
    const { tags } = capturedScopeTags(err);
    expect(tags["cli_error.class"]).toBe("ValidationError");
    expect(tags["cli_error.kind"]).toBe("Invalid trace ID");
  });

  test("ValidationError kind is stable across different user inputs", () => {
    const a = capturedScopeTags(
      new ValidationError('Invalid trace ID "abc"')
    ).tags;
    const b = capturedScopeTags(
      new ValidationError('Invalid trace ID "xyz-different"')
    ).tags;
    expect(a["cli_error.kind"]).toBe(b["cli_error.kind"]);
  });

  test("ValidationError kind differentiates by validator", () => {
    const traceErr = capturedScopeTags(
      new ValidationError('Invalid trace ID "abc"')
    ).tags;
    const eventErr = capturedScopeTags(
      new ValidationError('Invalid event ID "abc"')
    ).tags;
    expect(traceErr["cli_error.kind"]).not.toBe(eventErr["cli_error.kind"]);
  });

  test("silences ResolutionError and emits metric (CLI-RP)", () => {
    // ResolutionError is user-input noise (value provided but not found),
    // not a CLI bug — silence it so it doesn't pollute the issue tracker.
    const err = new ResolutionError(
      "Project 'x'",
      "not found",
      "sentry issue list <org>/x"
    );
    reportCliError(err);
    expect(captureSpy).not.toHaveBeenCalled();
    expect(metricSpy).toHaveBeenCalledWith(
      "cli.error.silenced",
      1,
      expect.objectContaining({
        attributes: expect.objectContaining({
          error_class: "ResolutionError",
          reason: "user_input_error",
        }),
      })
    );
  });

  test("captures SeerError (marketing dashboard)", () => {
    reportCliError(new SeerError("not_enabled", "my-org"));
    expect(captureSpy).toHaveBeenCalled();
    expect(metricSpy).not.toHaveBeenCalled();
  });

  test("silences SeerError on self-hosted and emits metric (CLI-1WP)", () => {
    withSentryUrl("https://sentry.example.com", () => {
      reportCliError(new SeerError("not_enabled", "my-org"));
    });
    expect(captureSpy).not.toHaveBeenCalled();
    expect(metricSpy).toHaveBeenCalledWith(
      "cli.error.silenced",
      1,
      expect.objectContaining({
        attributes: expect.objectContaining({
          error_class: "SeerError",
          reason: "seer_unavailable_self_hosted",
          seer_reason: "not_enabled",
        }),
      })
    );
  });

  test("silences AuthError(invalid) and emits metric", () => {
    reportCliError(new AuthError("invalid"));
    expect(captureSpy).not.toHaveBeenCalled();
    expect(metricSpy).toHaveBeenCalledWith(
      "cli.error.silenced",
      1,
      expect.objectContaining({
        attributes: expect.objectContaining({
          reason: "auth_expected",
          auth_reason: "invalid",
        }),
      })
    );
  });

  test("captures malformed-token failures once without retaining credentials", () => {
    const firstPart = "sntrys_reporting-secret-first";
    const secondPart = "reporting-secret-second";
    let error: unknown;
    try {
      formatAuthHeader(`${firstPart}\n${secondPart}`);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(MalformedAuthTokenError);

    const { tags, contexts } = capturedScopeTags(error);
    expect(captureSpy).toHaveBeenCalledExactlyOnceWith(error);
    expect(metricSpy).not.toHaveBeenCalled();
    expect(tags).toMatchObject({
      "cli_error.class": "MalformedAuthTokenError",
      "cli_error.kind": "invalid",
    });

    const captured = captureSpy.mock.calls[0]?.[0] as Error;
    expect(captured.cause).toBeUndefined();
    const diagnostics = JSON.stringify({
      properties: Object.getOwnPropertyDescriptors(captured),
      tags,
      contexts,
    });
    expect(diagnostics).not.toContain(firstPart);
    expect(diagnostics).not.toContain(secondPart);
  });

  test("captures ApiError(400) with normalized endpoint tag", () => {
    const err = new ApiError(
      "failed",
      400,
      undefined,
      "/api/0/organizations/my-org/issues/"
    );
    const { tags } = capturedScopeTags(err);
    expect(tags["cli_error.api_status"]).toBe("400");
    expect(tags["cli_error.kind"]).toBe("400");
    expect(tags["cli_error.api_endpoint"]).toBe(
      "/api/0/organizations/{org}/issues/"
    );
  });

  test("ApiError without endpoint does not set api_endpoint tag", () => {
    const { tags } = capturedScopeTags(new ApiError("failed", 500));
    expect(tags["cli_error.api_status"]).toBe("500");
    expect(tags["cli_error.api_endpoint"]).toBeUndefined();
  });

  test("HostScopeError gets kind=host_scope", () => {
    const { tags } = capturedScopeTags(
      new HostScopeError("URL argument", "https://other.sentry.io", "sentry.io")
    );
    expect(tags["cli_error.class"]).toBe("HostScopeError");
    expect(tags["cli_error.kind"]).toBe("host_scope");
  });

  test("WizardError gets kind=wizard", () => {
    const { tags } = capturedScopeTags(
      new WizardError("Workflow returned an error")
    );
    expect(tags["cli_error.class"]).toBe("WizardError");
    expect(tags["cli_error.kind"]).toBe("wizard");
  });

  test("bare CliError gets kind from message prefix", () => {
    const { tags } = capturedScopeTags(
      new CliError("Failed to create project 'my-app' in my-org.")
    );
    expect(tags["cli_error.class"]).toBe("CliError");
    expect(tags["cli_error.kind"]).toBe("Failed to create project");
  });

  test("bare CliError kind is stable across different user inputs", () => {
    const a = capturedScopeTags(
      new CliError("Failed to create project 'app-a' in org-a.")
    ).tags;
    const b = capturedScopeTags(
      new CliError("Failed to create project 'app-b' in org-b.")
    ).tags;
    expect(a["cli_error.kind"]).toBe(b["cli_error.kind"]);
  });

  test.each([
    401, 403, 404, 429,
  ])("SILENCES ApiError(%i) and emits metric", (status) => {
    reportCliError(new ApiError("user err", status, "detail", "/api/0/foo/"));
    expect(captureSpy).not.toHaveBeenCalled();
    expect(metricSpy).toHaveBeenCalledWith(
      "cli.error.silenced",
      1,
      expect.objectContaining({
        attributes: expect.objectContaining({
          error_class: "ApiError",
          reason: "api_user_error",
          api_status: status,
        }),
      })
    );
  });

  test("silences OutputError and emits metric", () => {
    reportCliError(new OutputError(null));
    expect(captureSpy).not.toHaveBeenCalled();
    expect(metricSpy).toHaveBeenCalledWith(
      "cli.error.silenced",
      1,
      expect.objectContaining({
        attributes: expect.objectContaining({ reason: "output_error" }),
      })
    );
  });

  test("silences a network error and emits metric", () => {
    reportCliError(new TypeError("fetch failed"));
    expect(captureSpy).not.toHaveBeenCalled();
    expect(metricSpy).toHaveBeenCalledWith(
      "cli.error.silenced",
      1,
      expect.objectContaining({
        attributes: expect.objectContaining({ reason: "network_error" }),
      })
    );
  });

  test.each([
    "not_authenticated",
    "expired",
  ] as const)("silences AuthError(%s) and emits metric", (reason) => {
    reportCliError(new AuthError(reason));
    expect(captureSpy).not.toHaveBeenCalled();
    expect(metricSpy).toHaveBeenCalledWith(
      "cli.error.silenced",
      1,
      expect.objectContaining({
        attributes: expect.objectContaining({
          reason: "auth_expected",
          auth_reason: reason,
        }),
      })
    );
  });

  test("captures ApiError(500) without silencing metric", () => {
    reportCliError(new ApiError("server fail", 500));
    expect(captureSpy).toHaveBeenCalled();
    expect(metricSpy).not.toHaveBeenCalled();
  });
});
