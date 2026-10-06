/**
 * Span View Command Tests
 *
 * Tests for positional argument parsing, span ID validation,
 * and output formatting in src/commands/span/view.ts.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  parsePositionalArgs,
  viewCommand,
} from "../../../src/commands/span/view.js";

vi.mock("../../../src/lib/api-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/api-client.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as apiClient from "../../../src/lib/api-client.js";
import { DEFAULT_SENTRY_URL } from "../../../src/lib/constants.js";
import { setOrgRegion } from "../../../src/lib/db/regions.js";
import {
  ContextError,
  ResolutionError,
  ValidationError,
} from "../../../src/lib/errors.js";
import { validateSpanId } from "../../../src/lib/hex-id.js";

vi.mock("../../../src/lib/resolve-target.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/resolve-target.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as resolveTarget from "../../../src/lib/resolve-target.js";

const VALID_TRACE_ID = "aaaa1111bbbb2222cccc3333dddd4444";
const VALID_SPAN_ID = "a1b2c3d4e5f67890";
const VALID_SPAN_ID_2 = "1234567890abcdef";

describe("validateSpanId", () => {
  test("accepts valid 16-char lowercase hex", () => {
    expect(validateSpanId("a1b2c3d4e5f67890")).toBe("a1b2c3d4e5f67890");
  });

  test("normalizes uppercase to lowercase", () => {
    expect(validateSpanId("A1B2C3D4E5F67890")).toBe("a1b2c3d4e5f67890");
  });

  test("trims whitespace", () => {
    expect(validateSpanId("  a1b2c3d4e5f67890  ")).toBe("a1b2c3d4e5f67890");
  });

  test("throws for non-hex characters", () => {
    expect(() => validateSpanId("g1b2c3d4e5f67890")).toThrow(ValidationError);
  });

  test("throws for too short", () => {
    expect(() => validateSpanId("a1b2c3d4")).toThrow(ValidationError);
  });

  test("throws for too long", () => {
    expect(() => validateSpanId("a1b2c3d4e5f678901234")).toThrow(
      ValidationError
    );
  });

  test("throws for empty string", () => {
    expect(() => validateSpanId("")).toThrow(ValidationError);
  });

  test("error message includes the invalid value", () => {
    try {
      validateSpanId("bad");
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect((error as ValidationError).message).toContain("bad");
    }
  });
});

describe("parsePositionalArgs", () => {
  describe("trace-id + single span-id", () => {
    test("returns deferred form for two-arg input (trace-ID recovery runs in command)", () => {
      const result = parsePositionalArgs([VALID_TRACE_ID, VALID_SPAN_ID]);
      expect(result.kind).toBe("deferred");
      if (result.kind !== "deferred") throw new Error("unreachable");
      expect(result.rawTraceArg).toBe(VALID_TRACE_ID);
      expect(result.rawSpanIds).toEqual([VALID_SPAN_ID]);
    });
  });

  describe("trace-id + multiple span-ids", () => {
    test("passes multiple span IDs through as raw", () => {
      const result = parsePositionalArgs([
        VALID_TRACE_ID,
        VALID_SPAN_ID,
        VALID_SPAN_ID_2,
      ]);
      expect(result.kind).toBe("deferred");
      if (result.kind !== "deferred") throw new Error("unreachable");
      expect(result.rawTraceArg).toBe(VALID_TRACE_ID);
      expect(result.rawSpanIds).toEqual([VALID_SPAN_ID, VALID_SPAN_ID_2]);
    });
  });

  describe("org/project/trace-id + span-id", () => {
    test("slash-separated target is deferred intact", () => {
      const slashForm = `my-org/my-project/${VALID_TRACE_ID}`;
      const result = parsePositionalArgs([slashForm, VALID_SPAN_ID]);
      expect(result.kind).toBe("deferred");
      if (result.kind !== "deferred") throw new Error("unreachable");
      expect(result.rawTraceArg).toBe(slashForm);
      expect(result.rawSpanIds).toEqual([VALID_SPAN_ID]);
    });

    test("slash-separated target with multiple span IDs", () => {
      const slashForm = `my-org/my-project/${VALID_TRACE_ID}`;
      const result = parsePositionalArgs([
        slashForm,
        VALID_SPAN_ID,
        VALID_SPAN_ID_2,
      ]);
      expect(result.kind).toBe("deferred");
      if (result.kind !== "deferred") throw new Error("unreachable");
      expect(result.rawTraceArg).toBe(slashForm);
      expect(result.rawSpanIds).toEqual([VALID_SPAN_ID, VALID_SPAN_ID_2]);
    });
  });

  describe("auto-split traceId/spanId single-arg format", () => {
    test("auto-splits traceId/spanId single-arg format (resolved path)", () => {
      const result = parsePositionalArgs([
        "aaaa1111bbbb2222cccc3333dddd4444/a1b2c3d4e5f67890",
      ]);
      expect(result.kind).toBe("resolved");
      if (result.kind !== "resolved") throw new Error("unreachable");
      expect(result.traceTarget.traceId).toBe(
        "aaaa1111bbbb2222cccc3333dddd4444"
      );
      expect(result.traceTarget.type).toBe("auto-detect");
      expect(result.rawSpanIds).toEqual(["a1b2c3d4e5f67890"]);
    });

    test("auto-splits with uppercase hex IDs", () => {
      const result = parsePositionalArgs([
        "AAAA1111BBBB2222CCCC3333DDDD4444/A1B2C3D4E5F67890",
      ]);
      expect(result.kind).toBe("resolved");
      if (result.kind !== "resolved") throw new Error("unreachable");
      expect(result.traceTarget.traceId).toBe(
        "aaaa1111bbbb2222cccc3333dddd4444"
      );
      expect(result.rawSpanIds).toEqual(["a1b2c3d4e5f67890"]);
    });

    test("does not auto-split org/traceId format (two args) — defers to command", () => {
      // org/traceId has a non-hex org slug, so it shouldn't trigger the auto-split
      const result = parsePositionalArgs([
        "my-org/aaaa1111bbbb2222cccc3333dddd4444",
        "a1b2c3d4e5f67890",
      ]);
      expect(result.kind).toBe("deferred");
      if (result.kind !== "deferred") throw new Error("unreachable");
      expect(result.rawTraceArg).toBe(
        "my-org/aaaa1111bbbb2222cccc3333dddd4444"
      );
      expect(result.rawSpanIds).toEqual(["a1b2c3d4e5f67890"]);
    });

    test("does not auto-split when left is not a valid trace ID", () => {
      // Auto-split requires hex-on-both-sides. When left is non-hex,
      // the single-arg input falls through to the "missing span IDs"
      // branch and throws ContextError. (A two-arg variant would defer
      // to the command layer — covered by other tests.)
      expect(() =>
        parsePositionalArgs(["not-a-hex-id/a1b2c3d4e5f67890"])
      ).toThrow(ContextError);
    });

    test("does not auto-split when right is not a valid span ID", () => {
      // Right side 32-char hex is a trace ID (not a span ID) so the
      // auto-split heuristic rejects it. As a single-arg form there are
      // no span IDs in a second positional → ContextError.
      expect(() =>
        parsePositionalArgs([
          "aaaa1111bbbb2222cccc3333dddd4444/bbbb2222cccc3333dddd4444eeee5555",
        ])
      ).toThrow(ContextError);
    });

    test("does not auto-split with multiple slashes (defers to command)", () => {
      // org/project/traceId format — deferred to the command layer
      // which calls parseTraceTargetWithRecovery.
      const slashForm = `my-org/my-project/${VALID_TRACE_ID}`;
      const result = parsePositionalArgs([slashForm, VALID_SPAN_ID]);
      expect(result.kind).toBe("deferred");
      if (result.kind !== "deferred") throw new Error("unreachable");
      expect(result.rawTraceArg).toBe(slashForm);
    });

    test("org/project/spanId (missing trace ID) throws a trace-focused ContextError (CLI-1GP)", () => {
      try {
        parsePositionalArgs([`my-org/my-project/${VALID_SPAN_ID}`]);
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ContextError);
        const msg = (error as ContextError).message;
        // Points at the missing trace ID, not a missing span ID.
        expect(msg).toContain("trace ID");
        expect(msg).toContain(VALID_SPAN_ID);
        // Does not misdirect the user to `span list` with the span ID.
        expect(msg).not.toContain(
          `span list my-org/my-project/${VALID_SPAN_ID}`
        );
      }
    });

    test("org/project/badTrace/spanId surfaces the trace validation detail", () => {
      try {
        parsePositionalArgs([`my-org/my-project/not-a-trace/${VALID_SPAN_ID}`]);
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ContextError);
        const msg = (error as ContextError).message;
        expect(msg).toContain("trace ID");
      }
    });
  });

  describe("error cases", () => {
    test("throws ContextError for empty args", () => {
      expect(() => parsePositionalArgs([])).toThrow(ContextError);
    });

    test("error message mentions trace ID and span ID", () => {
      try {
        parsePositionalArgs([]);
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ContextError);
        expect((error as ContextError).message).toContain("Trace ID");
      }
    });

    test("throws ContextError when only trace ID provided (no span IDs)", () => {
      expect(() => parsePositionalArgs([VALID_TRACE_ID])).toThrow(ContextError);
    });

    test("missing span IDs error suggests span list", () => {
      try {
        parsePositionalArgs([VALID_TRACE_ID]);
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ContextError);
        expect((error as ContextError).message).toContain("span list");
      }
    });

    test("accepts invalid trace ID as raw (recovery runs at command layer)", () => {
      // Previously threw synchronously; now the command-level recovery
      // path (parseTraceTargetWithRecovery) handles malformed trace IDs
      // consistent with `trace view`.
      const result = parsePositionalArgs(["not-valid", VALID_SPAN_ID]);
      expect(result.kind).toBe("deferred");
      if (result.kind !== "deferred") throw new Error("unreachable");
      expect(result.rawTraceArg).toBe("not-valid");
    });

    test("accepts invalid span ID as raw (validation deferred to command)", () => {
      // parsePositionalArgs no longer validates span IDs so the command
      // layer can run recovery with full trace context.
      const result = parsePositionalArgs([VALID_TRACE_ID, "not-a-span-id"]);
      expect(result.rawSpanIds).toEqual(["not-a-span-id"]);
    });

    test("accepts too-short span ID as raw", () => {
      const result = parsePositionalArgs([VALID_TRACE_ID, "abcd1234"]);
      expect(result.rawSpanIds).toEqual(["abcd1234"]);
    });

    test("throws ContextError for bare span ID without trace ID (CLI-SC)", () => {
      expect(() => parsePositionalArgs(["a1b2c3d4e5f67890"])).toThrow(
        ContextError
      );
    });

    test("bare span ID error identifies the input and suggests correct usage", () => {
      try {
        parsePositionalArgs(["A1B2C3D4E5F67890"]);
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ContextError);
        const msg = (error as ContextError).message;
        expect(msg).toContain("looks like a span ID");
        expect(msg).toContain("sentry span view <trace-id> a1b2c3d4e5f67890");
        expect(msg).toContain("sentry trace list");
      }
    });

    test("bare span ID with dashes is still detected (CLI-SC)", () => {
      // Some tools format span IDs with dashes
      expect(() => parsePositionalArgs(["a1b2-c3d4-e5f6-7890"])).toThrow(
        ContextError
      );
    });
  });
});

// ---------------------------------------------------------------------------
// viewCommand.func — tests the command body with mocked APIs
// ---------------------------------------------------------------------------

type ViewFunc = (
  this: unknown,
  flags: Record<string, unknown>,
  ...args: string[]
) => Promise<void>;

/** Minimal trace span tree for testing */
function makeTraceSpan(spanId: string, children: unknown[] = []): unknown {
  return {
    span_id: spanId,
    parent_span_id: null,
    op: "http.server",
    description: "GET /api",
    start_timestamp: 1_700_000_000,
    timestamp: 1_700_000_001,
    duration: 1000,
    project_slug: "test-project",
    transaction: "GET /api",
    children,
  };
}

describe("viewCommand.func", () => {
  let func: ViewFunc;
  let getDetailedTraceSpy: ReturnType<typeof spyOn>;
  let getSpanDetailsSpy: ReturnType<typeof spyOn>;
  let resolveOrgAndProjectSpy: ReturnType<typeof spyOn>;

  function createContext() {
    const stdoutChunks: string[] = [];
    return {
      context: {
        stdout: {
          write: vi.fn((s: string) => {
            stdoutChunks.push(s);
          }),
        },
        stderr: {
          write: vi.fn((_s: string) => {
            /* no-op */
          }),
        },
        cwd: "/tmp/test-project",
      },
      getStdout: () => stdoutChunks.join(""),
    };
  }

  beforeEach(async () => {
    func = (await viewCommand.loader()) as unknown as ViewFunc;
    getDetailedTraceSpy = vi.spyOn(apiClient, "getDetailedTrace");
    getSpanDetailsSpy = vi
      .spyOn(apiClient, "getSpanDetails")
      .mockResolvedValue({
        itemId: "mock-span",
        itemType: "span",
        attributes: [],
      });
    resolveOrgAndProjectSpy = vi.spyOn(resolveTarget, "resolveOrgAndProject");
    resolveOrgAndProjectSpy.mockResolvedValue({
      org: "test-org",
      project: "test-project",
    });
    // Pre-populate org region cache to prevent resolveOrgRegion from fetching
    setOrgRegion("test-org", DEFAULT_SENTRY_URL);
    setOrgRegion("my-org", DEFAULT_SENTRY_URL);
  });

  afterEach(() => {
    getDetailedTraceSpy.mockRestore();
    getSpanDetailsSpy.mockRestore();
    resolveOrgAndProjectSpy.mockRestore();
  });

  test("renders span details for a found span", async () => {
    getDetailedTraceSpy.mockResolvedValue([makeTraceSpan(VALID_SPAN_ID)]);

    const { context, getStdout } = createContext();

    await func.call(
      context,
      {
        spans: 3,
        fresh: false,
      },
      VALID_TRACE_ID,
      VALID_SPAN_ID
    );

    const output = getStdout();
    expect(output).toContain(VALID_SPAN_ID);
    expect(output).toContain("http.server");
  });

  test("throws ResolutionError when trace has no spans", async () => {
    getDetailedTraceSpy.mockResolvedValue([]);

    const { context } = createContext();

    await expect(
      func.call(
        context,
        {
          spans: 3,
          fresh: false,
        },
        VALID_TRACE_ID,
        VALID_SPAN_ID
      )
    ).rejects.toThrow(ResolutionError);
  });

  test("throws ResolutionError when span ID not found in trace", async () => {
    getDetailedTraceSpy.mockResolvedValue([makeTraceSpan("0000000000000000")]);

    const { context } = createContext();

    await expect(
      func.call(
        context,
        {
          spans: 3,
          fresh: false,
        },
        VALID_TRACE_ID,
        VALID_SPAN_ID
      )
    ).rejects.toThrow(ResolutionError);
  });

  test("uses explicit org/project from slash-separated arg", async () => {
    getDetailedTraceSpy.mockResolvedValue([makeTraceSpan(VALID_SPAN_ID)]);

    const { context } = createContext();

    await func.call(
      context,
      {
        spans: 0,
        fresh: false,
      },
      `my-org/my-project/${VALID_TRACE_ID}`,
      VALID_SPAN_ID
    );

    expect(getDetailedTraceSpy).toHaveBeenCalledWith("my-org", VALID_TRACE_ID);
    expect(resolveOrgAndProjectSpy).not.toHaveBeenCalled();
  });

  test("renders multiple spans with partial matches", async () => {
    const FOUND_SPAN = "aaaa111122223333";
    const MISSING_SPAN = "bbbb444455556666";
    getDetailedTraceSpy.mockResolvedValue([makeTraceSpan(FOUND_SPAN)]);

    const { context, getStdout } = createContext();

    // One span found, one missing — should render the found one and warn about the missing one
    await func.call(
      context,
      { spans: 0, fresh: false },
      VALID_TRACE_ID,
      FOUND_SPAN,
      MISSING_SPAN
    );

    const output = getStdout();
    expect(output).toContain(FOUND_SPAN);
  });

  test("renders span with child tree when --spans > 0", async () => {
    const childSpan = makeTraceSpan("childspan1234567");
    getDetailedTraceSpy.mockResolvedValue([
      makeTraceSpan(VALID_SPAN_ID, [childSpan]),
    ]);

    const { context, getStdout } = createContext();

    await func.call(
      context,
      { spans: 3, fresh: false },
      VALID_TRACE_ID,
      VALID_SPAN_ID
    );

    const output = getStdout();
    expect(output).toContain(VALID_SPAN_ID);
    // Span tree should include child info
    expect(output).toContain("Span Tree");
  });

  test("outputs JSON when --json flag is set", async () => {
    getDetailedTraceSpy.mockResolvedValue([makeTraceSpan(VALID_SPAN_ID)]);

    const { context, getStdout } = createContext();

    await func.call(
      context,
      { spans: 0, fresh: false, json: true },
      VALID_TRACE_ID,
      VALID_SPAN_ID
    );

    const output = getStdout();
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].span_id).toBe(VALID_SPAN_ID);
    expect(parsed[0].trace_id).toBe(VALID_TRACE_ID);
    expect(parsed[0].duration).toBeDefined();
    expect(parsed[0].ancestors).toEqual([]);
  });

  test("throws ContextError for org-all target (org/ without project)", async () => {
    const { context } = createContext();

    // "my-org/" is parsed as org-all mode which is not supported for span view
    await expect(
      func.call(
        context,
        { spans: 0, fresh: false },
        `my-org/my-project/${VALID_TRACE_ID}`
        // No span IDs — but we need at least one
      )
    ).rejects.toThrow(ContextError);
  });

  test("throws ResolutionError for multiple missing span IDs", async () => {
    getDetailedTraceSpy.mockResolvedValue([makeTraceSpan("0000000000000000")]);

    const { context } = createContext();

    await expect(
      func.call(
        context,
        { spans: 0, fresh: false },
        VALID_TRACE_ID,
        VALID_SPAN_ID,
        VALID_SPAN_ID_2
      )
    ).rejects.toThrow(ResolutionError);
  });
});
