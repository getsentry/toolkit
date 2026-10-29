/**
 * Tests for shared trace-target parsing and resolution.
 *
 * Tests parseTraceTarget, the dual-mode parsers, and the resolvers from
 * src/lib/trace-target.ts. The syntax itself is tested in
 * id-arguments.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../src/lib/api-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/lib/api-client.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([key, value]) => [
      key,
      typeof value === "function" ? vi.fn(value) : value,
    ]),
  );
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as apiClient from "../../src/lib/api-client.js";
import {
  ContextError,
  ResolutionError,
  ValidationError,
} from "../../src/lib/errors.js";
import {
  parseDualModeArgs,
  parseDualModeInput,
  parseTraceTarget,
  parseTraceTargetInput,
  resolveTraceOrg,
  resolveTraceOrgOptionalProject,
  resolveTraceOrgProject,
} from "../../src/lib/trace-target.js";

const VALID_TRACE_ID = "aaaa1111bbbb2222cccc3333dddd4444";

describe("parseTraceTarget with one argument", () => {
  const HINT = "sentry span list [<org>/<project>/]<trace-id>";

  test("bare trace ID → auto-detect", () => {
    const result = parseTraceTarget([VALID_TRACE_ID], HINT);
    expect(result.type).toBe("auto-detect");
    expect(result.traceId).toBe(VALID_TRACE_ID);
  });

  test("normalizes uppercase trace ID", () => {
    const result = parseTraceTarget(["AAAA1111BBBB2222CCCC3333DDDD4444"], HINT);
    expect(result.traceId).toBe(VALID_TRACE_ID);
  });

  test("strips UUID dashes from trace ID", () => {
    const result = parseTraceTarget(
      ["aaaa1111-bbbb-2222-cccc-3333dddd4444"],
      HINT,
    );
    expect(result.traceId).toBe(VALID_TRACE_ID);
  });

  test("org/trace-id → org-scoped", () => {
    const result = parseTraceTarget([`my-org/${VALID_TRACE_ID}`], HINT);
    expect(result.type).toBe("org-scoped");
    expect(result.traceId).toBe(VALID_TRACE_ID);
    if (result.type === "org-scoped") {
      expect(result.org).toBe("my-org");
    }
  });

  test("org/project/trace-id → explicit", () => {
    const result = parseTraceTarget(
      [`my-org/my-project/${VALID_TRACE_ID}`],
      HINT,
    );
    expect(result.type).toBe("explicit");
    expect(result.traceId).toBe(VALID_TRACE_ID);
    if (result.type === "explicit") {
      expect(result.org).toBe("my-org");
      expect(result.project).toBe("my-project");
    }
  });

  test("preserves underscores in slugs (see #770)", () => {
    // Sentry accepts underscores in project slugs, so they must flow
    // through the trace-target parser unchanged.
    const result = parseTraceTarget(
      [`my_org/my_project/${VALID_TRACE_ID}`],
      HINT,
    );
    expect(result.type).toBe("explicit");
    if (result.type === "explicit") {
      expect(result.org).toBe("my_org");
      expect(result.project).toBe("my_project");
      expect(result.normalized).toBeUndefined();
    }
  });

  test("trailing slash without trace ID throws", () => {
    expect(() => parseTraceTarget(["my-org/"], HINT)).toThrow(ContextError);
  });

  test("invalid trace ID throws ValidationError", () => {
    expect(() => parseTraceTarget(["not-a-trace-id"], HINT)).toThrow(
      ValidationError,
    );
  });
});

describe("parseTraceTarget with a target argument", () => {
  test("explicit target (org/project)", () => {
    const result = parseTraceTarget(
      ["my-org/my-project", VALID_TRACE_ID],
      "sentry trace view <target> <trace-id>",
    );
    expect(result.type).toBe("explicit");
    expect(result.traceId).toBe(VALID_TRACE_ID);
  });

  test("org-all target (org/) → org-scoped", () => {
    const result = parseTraceTarget(
      ["my-org/", VALID_TRACE_ID],
      "sentry trace view <target> <trace-id>",
    );
    expect(result.type).toBe("org-scoped");
    if (result.type === "org-scoped") {
      expect(result.org).toBe("my-org");
    }
  });

  test("bare slug → project-search", () => {
    const result = parseTraceTarget(
      ["frontend", VALID_TRACE_ID],
      "sentry trace view <target> <trace-id>",
    );
    expect(result.type).toBe("project-search");
    if (result.type === "project-search") {
      expect(result.projectSlug).toBe("frontend");
    }
  });

  test("preserves scoped display-name metadata", () => {
    const result = parseTraceTarget(
      ["my-org/My Project", VALID_TRACE_ID],
      "sentry trace view <target> <trace-id>",
    );
    expect(result).toMatchObject({
      type: "project-search",
      org: "my-org",
      projectSlug: "My Project",
      originalSlug: "My Project",
    });
  });

  test("empty string → auto-detect", () => {
    const result = parseTraceTarget(
      ["", VALID_TRACE_ID],
      "sentry trace view <target> <trace-id>",
    );
    expect(result.type).toBe("auto-detect");
  });
});

describe("trace target resolution", () => {
  let findProjectsBySlugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    findProjectsBySlugSpy = vi.spyOn(apiClient, "findProjectsBySlug");
  });

  afterEach(() => {
    findProjectsBySlugSpy.mockRestore();
  });

  test("org-only mode uses the parent org of a matching bare project", async () => {
    findProjectsBySlugSpy.mockResolvedValue({
      projects: [
        {
          id: "1",
          slug: "frontend",
          name: "Frontend",
          orgSlug: "project-owner",
        },
      ],
      orgs: [{ slug: "project-owner", name: "Project Owner" }],
    });
    const parsed = parseTraceTarget(
      ["frontend", VALID_TRACE_ID],
      "sentry trace view <target> <trace-id>",
    );

    const resolved = await resolveTraceOrg(
      parsed,
      "/tmp",
      "sentry trace logs [<org>/[<project>/]]<trace-id>",
    );

    expect(resolved.org).toBe("project-owner");
  });

  test("project-bound errors preserve the full trace usage hint", async () => {
    findProjectsBySlugSpy.mockResolvedValue({ projects: [], orgs: [] });
    const parsed = parseTraceTarget(
      ["missing", VALID_TRACE_ID],
      "sentry trace view <target> <trace-id>",
    );
    const usageHint = "sentry span view [<org>/<project>/]<span-id>";

    try {
      await resolveTraceOrgProject(parsed, "/tmp", usageHint);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ResolutionError);
      expect((error as ResolutionError).hint).toBe(usageHint);
    }
  });

  test("org-capable errors preserve the full trace usage hint", async () => {
    findProjectsBySlugSpy.mockResolvedValue({ projects: [], orgs: [] });
    const parsed = parseTraceTarget(
      ["missing", VALID_TRACE_ID],
      "sentry trace view <target> <trace-id>",
    );
    const usageHint = "sentry trace view [<org>/<project>/]<trace-id>";

    try {
      await resolveTraceOrgOptionalProject(parsed, "/tmp", usageHint);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ResolutionError);
      expect((error as ResolutionError).hint).toBe(usageHint);
    }
  });
});

describe("parseTraceTarget", () => {
  const HINT = "sentry span list [<org>/<project>/]<trace-id>";

  test("empty args throws ContextError", () => {
    expect(() => parseTraceTarget([], HINT)).toThrow(ContextError);
  });

  test("single arg: bare trace ID → auto-detect", () => {
    const result = parseTraceTarget([VALID_TRACE_ID], HINT);
    expect(result.type).toBe("auto-detect");
    expect(result.traceId).toBe(VALID_TRACE_ID);
  });

  test("single arg: org/project/trace-id → explicit", () => {
    const result = parseTraceTarget(
      [`my-org/my-project/${VALID_TRACE_ID}`],
      HINT,
    );
    expect(result.type).toBe("explicit");
    expect(result.traceId).toBe(VALID_TRACE_ID);
  });

  test("single arg: org/trace-id → org-scoped", () => {
    const result = parseTraceTarget([`my-org/${VALID_TRACE_ID}`], HINT);
    expect(result.type).toBe("org-scoped");
  });

  test("two args: target + trace-id", () => {
    const result = parseTraceTarget(
      ["my-org/my-project", VALID_TRACE_ID],
      HINT,
    );
    expect(result.type).toBe("explicit");
    expect(result.traceId).toBe(VALID_TRACE_ID);
  });

  test("two args: bare slug + trace-id → project-search", () => {
    const result = parseTraceTarget(["frontend", VALID_TRACE_ID], HINT);
    expect(result.type).toBe("project-search");
    expect(result.traceId).toBe(VALID_TRACE_ID);
  });

  test("invalid trace ID throws ValidationError", () => {
    expect(() => parseTraceTarget(["not-valid"], HINT)).toThrow(
      ValidationError,
    );
  });
});

describe("trailing slashes and Sentry trace URLs (CLI-13F)", () => {
  const HINT = "sentry trace view [<org>/<project>/]<trace-id>";
  let savedUrl: string | undefined;
  let savedHost: string | undefined;

  beforeEach(() => {
    savedUrl = process.env.SENTRY_URL;
    savedHost = process.env.SENTRY_HOST;
  });

  afterEach(() => {
    if (savedUrl === undefined) {
      delete process.env.SENTRY_URL;
    } else {
      process.env.SENTRY_URL = savedUrl;
    }
    if (savedHost === undefined) {
      delete process.env.SENTRY_HOST;
    } else {
      process.env.SENTRY_HOST = savedHost;
    }
  });

  test("canonical trace URL with trailing slash → org-scoped", () => {
    const result = parseTraceTarget(
      [`https://my-org.sentry.io/explore/traces/trace/${VALID_TRACE_ID}/`],
      HINT,
    );
    expect(result).toEqual({
      type: "org-scoped",
      traceId: VALID_TRACE_ID,
      org: "my-org",
    });
  });

  test("trace URL without trailing slash and with query → org-scoped", () => {
    const result = parseTraceTarget(
      [
        `https://my-org.sentry.io/explore/traces/trace/${VALID_TRACE_ID}?statsPeriod=24h`,
      ],
      HINT,
    );
    expect(result).toEqual({
      type: "org-scoped",
      traceId: VALID_TRACE_ID,
      org: "my-org",
    });
  });

  test("legacy /organizations/ trace URL → org-scoped", () => {
    const result = parseTraceTarget(
      [`https://sentry.io/organizations/my-org/traces/${VALID_TRACE_ID}/`],
      HINT,
    );
    expect(result.type).toBe("org-scoped");
    expect(result.traceId).toBe(VALID_TRACE_ID);
  });

  test("a Sentry URL without a trace ID is not a trace URL", () => {
    expect(() =>
      parseTraceTarget(["https://sentry.io/organizations/my-org/"], HINT),
    ).toThrow(ContextError);
  });

  test("org/project/<trace-id>/ → explicit", () => {
    const result = parseTraceTarget(
      [`my-org/my-project/${VALID_TRACE_ID}/`],
      HINT,
    );
    expect(result).toEqual({
      type: "explicit",
      traceId: VALID_TRACE_ID,
      org: "my-org",
      project: "my-project",
    });
  });

  test("<trace-id>/ → auto-detect", () => {
    const result = parseTraceTarget([`${VALID_TRACE_ID}/`], HINT);
    expect(result).toEqual({ type: "auto-detect", traceId: VALID_TRACE_ID });
  });

  test("org/project/ still throws ContextError (trace ID omitted)", () => {
    expect(() => parseTraceTarget(["my-org/my-project/"], HINT)).toThrow(
      ContextError,
    );
  });

  test("parseDualModeArgs treats a trace URL as trace mode", () => {
    const result = parseDualModeArgs(
      [`https://my-org.sentry.io/explore/traces/trace/${VALID_TRACE_ID}/`],
      HINT,
    );
    expect(result).toEqual({
      mode: "trace",
      parsed: { type: "org-scoped", traceId: VALID_TRACE_ID, org: "my-org" },
    });
  });

  test("parseDualModeArgs treats org/<trace-id>/ as trace mode", () => {
    const result = parseDualModeArgs([`my-org/${VALID_TRACE_ID}/`], HINT);
    expect(result.mode).toBe("trace");
  });
});

describe("parsing without side effects", () => {
  const HINT = "sentry log list [<org>/[<project>/]]<trace-id>";
  const SELF_HOSTED_URL = `https://sentry.example.com/organizations/acme/traces/${VALID_TRACE_ID}/`;
  let savedUrl: string | undefined;

  beforeEach(() => {
    savedUrl = process.env.SENTRY_URL;
  });

  afterEach(() => {
    if (savedUrl === undefined) {
      delete process.env.SENTRY_URL;
    } else {
      process.env.SENTRY_URL = savedUrl;
    }
  });

  test("a pasted URL's server is returned, not applied", () => {
    // Applying a server with no account throws HostScopeError
    expect(parseTraceTargetInput([SELF_HOSTED_URL], HINT)).toEqual({
      parsed: { type: "org-scoped", traceId: VALID_TRACE_ID, org: "acme" },
      baseUrl: "https://sentry.example.com",
      warnings: [],
    });
    expect(parseDualModeInput([SELF_HOSTED_URL], HINT)).toMatchObject({
      mode: "trace",
      trace: { baseUrl: "https://sentry.example.com" },
    });
    expect(process.env.SENTRY_URL).toBe(savedUrl);
  });

  test("ignored extra arguments are returned as a warning", () => {
    expect(
      parseTraceTargetInput(["acme/web", VALID_TRACE_ID, "extra"], HINT),
    ).toEqual({
      parsed: {
        type: "explicit",
        traceId: VALID_TRACE_ID,
        org: "acme",
        project: "web",
      },
      warnings: [`Extra arguments ignored: extra. Expected: ${HINT}`],
    });
  });
});
