/**
 * Property-Based Tests for Trace Target Parsing
 *
 * Uses fast-check to verify invariants of parseTraceTarget()
 * that should hold for any valid input. These tests cover the
 * shared abstraction used by trace view, span list, span view,
 * and trace logs.
 */

import {
  assert as fcAssert,
  integer,
  property,
  stringMatching,
  tuple,
  uniqueArray,
} from "fast-check";
import { describe, expect, test } from "vitest";
import { flattenSpanTree } from "../../../src/commands/trace/view.js";
import { ContextError, ValidationError } from "../../../src/lib/errors.js";
import { parseTraceTarget } from "../../../src/lib/trace-target.js";
import type { TraceSpan } from "../../../src/types/sentry.js";
import { DEFAULT_NUM_RUNS } from "../../model-based/helpers.js";

/** Valid trace IDs (32-char hex) */
const traceIdArb = stringMatching(/^[a-f0-9]{32}$/);

/** Valid org/project slugs (no xn-- punycode prefix) */
const slugArb = stringMatching(/^[a-z][a-z0-9-]{1,20}[a-z0-9]$/).filter(
  (s) => !s.startsWith("xn--")
);

const HINT = "sentry trace view [<org>/<project>/]<trace-id>";

/**
 * Insert dashes at UUID positions (8-4-4-4-12) into a 32-char hex string.
 */
function toUuidFormat(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

describe("parseTraceTarget properties", () => {
  test("single valid trace ID: returns auto-detect with correct traceId", async () => {
    await fcAssert(
      property(traceIdArb, (input) => {
        const result = parseTraceTarget([input], HINT);
        expect(result.type).toBe("auto-detect");
        expect(result.traceId).toBe(input);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("single arg org/project/traceId: returns explicit with correct fields", async () => {
    await fcAssert(
      property(
        tuple(slugArb, slugArb, traceIdArb),
        ([org, project, traceId]) => {
          const combined = `${org}/${project}/${traceId}`;
          const result = parseTraceTarget([combined], HINT);
          expect(result.type).toBe("explicit");
          expect(result.traceId).toBe(traceId);
          if (result.type === "explicit") {
            expect(result.org).toBe(org);
            expect(result.project).toBe(project);
          }
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("single arg org/traceId: returns org-scoped", async () => {
    await fcAssert(
      property(tuple(slugArb, traceIdArb), ([org, traceId]) => {
        const combined = `${org}/${traceId}`;
        const result = parseTraceTarget([combined], HINT);
        expect(result.type).toBe("org-scoped");
        expect(result.traceId).toBe(traceId);
        if (result.type === "org-scoped") {
          expect(result.org).toBe(org);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("two args: target + trace-id uses second arg as trace ID", async () => {
    await fcAssert(
      property(
        tuple(slugArb, slugArb, traceIdArb),
        ([org, project, traceId]) => {
          const target = `${org}/${project}`;
          const result = parseTraceTarget([target, traceId], HINT);
          expect(result.type).toBe("explicit");
          expect(result.traceId).toBe(traceId);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("parsing is deterministic", async () => {
    await fcAssert(
      property(tuple(slugArb, traceIdArb), ([target, traceId]) => {
        const args = [target, traceId];
        const result1 = parseTraceTarget(args, HINT);
        const result2 = parseTraceTarget(args, HINT);
        expect(result1).toEqual(result2);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("empty args always throws ContextError", () => {
    expect(() => parseTraceTarget([], HINT)).toThrow(ContextError);
  });

  test("result always has traceId property defined", async () => {
    await fcAssert(
      property(traceIdArb, (traceId) => {
        const result = parseTraceTarget([traceId], HINT);
        expect(result.traceId).toBeDefined();
        expect(typeof result.traceId).toBe("string");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("UUID-format trace IDs are accepted and produce 32-char hex", async () => {
    await fcAssert(
      property(traceIdArb, (hex) => {
        const uuid = toUuidFormat(hex);
        const result = parseTraceTarget([uuid], HINT);
        expect(result.traceId).toBe(hex);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("invalid trace IDs always throw ValidationError", async () => {
    const invalidIdArb = stringMatching(/^[g-z]{10,20}$/);
    await fcAssert(
      property(invalidIdArb, (badId) => {
        expect(() => parseTraceTarget([badId], HINT)).toThrow(ValidationError);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

// ============================================================================
// flattenSpanTree properties
// ============================================================================

/**
 * Build a span tree from a flat list of (spanId, parentIndex) pairs.
 * parentIndex = -1 means root. Otherwise index into the flat list.
 */
function buildTree(
  items: Array<{ id: string; parentIdx: number }>
): TraceSpan[] {
  const nodes: TraceSpan[] = items.map((item) => ({
    span_id: item.id,
    start_timestamp: 1,
  }));

  const roots: TraceSpan[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const node = nodes[i];
    if (!item) {
      continue;
    }
    if (!node) {
      continue;
    }
    if (item.parentIdx < 0 || item.parentIdx >= i) {
      roots.push(node);
    } else {
      const parent = nodes[item.parentIdx];
      if (parent) {
        if (!parent.children) {
          parent.children = [];
        }
        parent.children.push(node);
      }
    }
  }
  return roots;
}

/** Generate a span tree of 0-20 spans via flat list + tree construction */
const spanTreeArb = uniqueArray(stringMatching(/^[a-f0-9]{16}$/), {
  minLength: 0,
  maxLength: 20,
})
  .chain((ids) =>
    tuple(
      ...ids.map((id, i) =>
        integer({ min: -1, max: Math.max(0, i - 1) }).map((parentIdx) => ({
          id,
          parentIdx,
        }))
      )
    )
  )
  .map((items) => buildTree(items));

/** Count all spans in a tree recursively */
function countSpans(spans: TraceSpan[]): number {
  let count = 0;
  for (const span of spans) {
    count += 1;
    if (span.children) {
      count += countSpans(span.children);
    }
  }
  return count;
}

/** Collect all span IDs from a tree recursively */
function collectSpanIds(spans: TraceSpan[]): Set<string> {
  const ids = new Set<string>();
  for (const span of spans) {
    ids.add(span.span_id);
    if (span.children) {
      for (const id of collectSpanIds(span.children)) {
        ids.add(id);
      }
    }
  }
  return ids;
}

describe("flattenSpanTree properties", () => {
  test("result length equals total span count", async () => {
    await fcAssert(
      property(spanTreeArb, (tree) => {
        const result = flattenSpanTree(tree);
        expect(result).toHaveLength(countSpans(tree));
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("all returned spans exist in original tree", async () => {
    await fcAssert(
      property(spanTreeArb, (tree) => {
        const result = flattenSpanTree(tree);
        const originalIds = collectSpanIds(tree);
        for (const span of result) {
          expect(originalIds.has(span.span_id)).toBe(true);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("empty input returns empty output", () => {
    expect(flattenSpanTree([])).toEqual([]);
  });
});
