/**
 * Span View Command Tests
 *
 * Tests for positional argument parsing, span ID validation,
 * and output formatting in src/commands/span/view.ts.
 */

import { ArgumentParseError } from "@stricli/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  parseSpanViewInput,
  viewCommand,
} from "../../../src/commands/span/view.js";

vi.mock("../../../src/lib/api-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/api-client.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ]),
  );
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
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
    ]),
  );
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as resolveTarget from "../../../src/lib/resolve-target.js";
import { parseTraceArgumentsInput } from "../../../src/lib/trace-target.js";

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
      ValidationError,
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

describe("parseSpanViewInput", () => {
  /** The trace of `traceArg`, as `span view` parses it */
  const trace = (traceArg: string) =>
    parseTraceArgumentsInput([traceArg], "", { needsProject: true });
  const SLASH_FORM = `my-org/my-project/${VALID_TRACE_ID}`;

  test.each([
    [[VALID_TRACE_ID, VALID_SPAN_ID], VALID_TRACE_ID, [VALID_SPAN_ID]],
    [
      [VALID_TRACE_ID, VALID_SPAN_ID, VALID_SPAN_ID_2],
      VALID_TRACE_ID,
      [VALID_SPAN_ID, VALID_SPAN_ID_2],
    ],
    [[SLASH_FORM, VALID_SPAN_ID], SLASH_FORM, [VALID_SPAN_ID]],
    [
      [SLASH_FORM, VALID_SPAN_ID, VALID_SPAN_ID_2],
      SLASH_FORM,
      [VALID_SPAN_ID, VALID_SPAN_ID_2],
    ],
    [
      [`my-org/${VALID_TRACE_ID}`, VALID_SPAN_ID],
      `my-org/${VALID_TRACE_ID}`,
      [VALID_SPAN_ID],
    ],
    // `<trace-id>/<span-id>`, as span list prints it
    [[`${VALID_TRACE_ID}/${VALID_SPAN_ID}`], VALID_TRACE_ID, [VALID_SPAN_ID]],
    [
      [`${SLASH_FORM}/${VALID_SPAN_ID}`, VALID_SPAN_ID_2],
      SLASH_FORM,
      [VALID_SPAN_ID, VALID_SPAN_ID_2],
    ],
    // Several IDs in one argument (CLI-1BD)
    [[`${VALID_TRACE_ID} ${VALID_SPAN_ID}`], VALID_TRACE_ID, [VALID_SPAN_ID]],
    [[`${SLASH_FORM} ${VALID_SPAN_ID}`], SLASH_FORM, [VALID_SPAN_ID]],
    [
      [`${VALID_TRACE_ID}\n${VALID_SPAN_ID}\n${VALID_SPAN_ID_2}\n`],
      VALID_TRACE_ID,
      [VALID_SPAN_ID, VALID_SPAN_ID_2],
    ],
    [
      [`${VALID_TRACE_ID}/${VALID_SPAN_ID}\n${VALID_SPAN_ID_2}`],
      VALID_TRACE_ID,
      [VALID_SPAN_ID, VALID_SPAN_ID_2],
    ],
  ])("%j → trace %j, spans %j", (args, traceArg, rawSpanIds) => {
    expect(parseSpanViewInput(args)).toEqual({
      trace: trace(traceArg),
      rawSpanIds,
    });
  });

  test("keeps the case of IDs for the command to normalize", () => {
    expect(
      parseSpanViewInput(["AAAA1111BBBB2222CCCC3333DDDD4444/A1B2C3D4E5F67890"]),
    ).toEqual({
      trace: trace("AAAA1111BBBB2222CCCC3333DDDD4444"),
      rawSpanIds: ["A1B2C3D4E5F67890"],
    });
  });

  test("leaves malformed IDs raw, for recovery at the command layer", () => {
    expect(parseSpanViewInput(["not-valid", VALID_SPAN_ID])).toEqual({
      trace: trace("not-valid"),
      rawSpanIds: [VALID_SPAN_ID],
    });
    expect(parseSpanViewInput([`not-a-hex-id/${VALID_SPAN_ID}`])).toEqual({
      trace: trace("not-a-hex-id"),
      rawSpanIds: [VALID_SPAN_ID],
    });
    expect(
      parseSpanViewInput([`my-org/my-project/not-a-trace/${VALID_SPAN_ID}`]),
    ).toEqual({
      trace: trace("my-org/my-project/not-a-trace"),
      rawSpanIds: [VALID_SPAN_ID],
    });
    expect(parseSpanViewInput([VALID_TRACE_ID, "not-a-span-id"])).toEqual({
      trace: trace(VALID_TRACE_ID),
      rawSpanIds: ["not-a-span-id"],
    });
    expect(parseSpanViewInput([VALID_TRACE_ID, "abcd1234"]).rawSpanIds).toEqual(
      ["abcd1234"],
    );
  });

  test("org/project/spanId (missing trace ID) throws a trace-focused ContextError (CLI-1GP)", () => {
    try {
      parseSpanViewInput([`my-org/my-project/${VALID_SPAN_ID}`]);
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ContextError);
      const msg = (error as ContextError).message;
      // Points at the missing trace ID, not a missing span ID.
      expect(msg).toContain("trace ID");
      expect(msg).toContain(VALID_SPAN_ID);
      // Does not misdirect the user to `span list` with the span ID.
      expect(msg).not.toContain(`span list my-org/my-project/${VALID_SPAN_ID}`);
    }
  });

  describe("missing IDs", () => {
    test.each([
      [[]],
      [["   \n "]],
      [[VALID_TRACE_ID]],
      [[`  ${VALID_TRACE_ID}  `]],
      [[`${VALID_TRACE_ID}/bbbb2222cccc3333dddd4444eeee5555`]],
    ])("%j → ContextError", (args) => {
      expect(() => parseSpanViewInput(args)).toThrow(ContextError);
    });

    test("error message mentions trace ID and span ID", () => {
      expect(() => parseSpanViewInput([])).toThrow("Trace ID");
    });

    test("missing span IDs error suggests span list", () => {
      expect(() => parseSpanViewInput([VALID_TRACE_ID])).toThrow("span list");
    });

    test("throws ContextError for bare span ID without trace ID (CLI-SC)", () => {
      expect(() => parseSpanViewInput(["a1b2c3d4e5f67890"])).toThrow(
        ContextError,
      );
    });

    test("bare span ID error identifies the input and suggests correct usage", () => {
      try {
        parseSpanViewInput(["A1B2C3D4E5F67890"]);
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
      expect(() => parseSpanViewInput(["a1b2-c3d4-e5f6-7890"])).toThrow(
        "looks like a span ID",
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
      VALID_SPAN_ID,
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
        VALID_SPAN_ID,
      ),
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
        VALID_SPAN_ID,
      ),
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
      VALID_SPAN_ID,
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
      MISSING_SPAN,
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
      VALID_SPAN_ID,
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
      VALID_SPAN_ID,
    );

    const output = getStdout();
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].span_id).toBe(VALID_SPAN_ID);
    expect(parsed[0].trace_id).toBe(VALID_TRACE_ID);
    expect(parsed[0].duration).toBeDefined();
    expect(parsed[0].ancestors).toEqual([]);
  });

  test("fails to parse without span IDs, before resolving", async () => {
    const { context } = createContext();

    const error = await func
      .call(
        context,
        { spans: 0, fresh: false },
        `my-org/my-project/${VALID_TRACE_ID}`,
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ArgumentParseError);
    expect((error as ArgumentParseError).exception).toBeInstanceOf(
      ContextError,
    );
    expect(getDetailedTraceSpy).not.toHaveBeenCalled();
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
        VALID_SPAN_ID_2,
      ),
    ).rejects.toThrow(ResolutionError);
  });
});
