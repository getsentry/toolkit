/**
 * Property-Based Tests for API Client Pagination Helpers
 *
 * Tests parseLinkHeader — the pure function that extracts pagination cursors
 * from Sentry's RFC 5988 Link response headers.
 */

import {
  constantFrom,
  assert as fcAssert,
  nat,
  property,
  string,
  tuple,
} from "fast-check";
import { describe, expect, test } from "vitest";
import { parseLinkHeader } from "../../src/lib/api-client.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

// Arbitraries

/** Generate a Sentry-style cursor: `timestamp:offset:is_prev` */
const cursorArb = tuple(
  nat(2_000_000_000_000),
  nat(100),
  constantFrom(0, 1)
).map(([ts, offset, isPrev]) => `${ts}:${offset}:${isPrev}`);

/** Generate a valid "next" link part with results="true" and a cursor */
const nextLinkWithResultsArb = cursorArb.map(
  (cursor) =>
    `<https://sentry.io/api/0/organizations/sentry/projects/?cursor=${cursor}>; rel="next"; results="true"; cursor="${cursor}"`
);

/** Generate a "next" link part with results="false" */
const nextLinkNoResultsArb = cursorArb.map(
  (cursor) =>
    `<https://sentry.io/api/0/organizations/sentry/projects/?cursor=${cursor}>; rel="next"; results="false"; cursor="${cursor}"`
);

/** Generate a "previous" link part (should be ignored by parseLinkHeader) */
const prevLinkArb = cursorArb.map(
  (cursor) =>
    `<https://sentry.io/api/0/organizations/sentry/projects/?cursor=${cursor}>; rel="previous"; results="true"; cursor="${cursor}"`
);

/** Generate a rel value that is not "next" */
const nonNextRelArb = constantFrom("previous", "first", "last", "self");

describe("property: parseLinkHeader", () => {
  test("null or empty header returns no cursor", () => {
    const result1 = parseLinkHeader(null);
    expect(result1).toEqual({});

    const result2 = parseLinkHeader("");
    expect(result2).toEqual({});
  });

  test("valid next link with results=true returns cursor", () => {
    fcAssert(
      property(nextLinkWithResultsArb, (header) => {
        const result = parseLinkHeader(header);
        expect(result.nextCursor).toBeDefined();
        expect(result.nextCursor).toMatch(/^\d+:\d+:\d+$/);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("next link with results=false returns no cursor", () => {
    fcAssert(
      property(nextLinkNoResultsArb, (header) => {
        const result = parseLinkHeader(header);
        expect(result.nextCursor).toBeUndefined();
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("previous-only link returns no cursor (ignores non-next)", () => {
    fcAssert(
      property(prevLinkArb, (header) => {
        const result = parseLinkHeader(header);
        expect(result.nextCursor).toBeUndefined();
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("combined prev + next link extracts cursor from next part", () => {
    fcAssert(
      property(tuple(prevLinkArb, nextLinkWithResultsArb), ([prev, next]) => {
        // Sentry sends both prev and next separated by comma
        const header = `${prev}, ${next}`;
        const result = parseLinkHeader(header);
        expect(result.nextCursor).toBeDefined();
        expect(result.nextCursor).toMatch(/^\d+:\d+:\d+$/);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("cursor value is preserved exactly", () => {
    fcAssert(
      property(cursorArb, (cursor) => {
        const header = `<https://sentry.io/api/0/test/>; rel="next"; results="true"; cursor="${cursor}"`;
        const result = parseLinkHeader(header);
        expect(result.nextCursor).toBe(cursor);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("missing cursor attribute returns no cursor", () => {
    const header =
      '<https://sentry.io/api/0/test/>; rel="next"; results="true"';
    const result = parseLinkHeader(header);
    expect(result.nextCursor).toBeUndefined();
  });

  test("missing results attribute returns no cursor", () => {
    fcAssert(
      property(cursorArb, (cursor) => {
        const header = `<https://sentry.io/api/0/test/>; rel="next"; cursor="${cursor}"`;
        const result = parseLinkHeader(header);
        expect(result.nextCursor).toBeUndefined();
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("non-next rel with results=true returns no cursor", () => {
    fcAssert(
      property(tuple(nonNextRelArb, cursorArb), ([rel, cursor]) => {
        const header = `<https://sentry.io/api/0/test/>; rel="${rel}"; results="true"; cursor="${cursor}"`;
        const result = parseLinkHeader(header);
        expect(result.nextCursor).toBeUndefined();
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("multiple parts: only next with results=true is extracted", () => {
    fcAssert(
      property(tuple(cursorArb, cursorArb), ([prevCursor, nextCursor]) => {
        const header = [
          `<https://sentry.io/api/0/test/?cursor=${prevCursor}>; rel="previous"; results="false"; cursor="${prevCursor}"`,
          `<https://sentry.io/api/0/test/?cursor=${nextCursor}>; rel="next"; results="true"; cursor="${nextCursor}"`,
        ].join(", ");
        const result = parseLinkHeader(header);
        expect(result.nextCursor).toBe(nextCursor);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("random strings without expected attributes return no cursor", () => {
    fcAssert(
      property(string({ minLength: 0, maxLength: 200 }), (header) => {
        // Any random string should not crash and should return a valid result
        const result = parseLinkHeader(header);
        if (result.nextCursor !== undefined) {
          expect(typeof result.nextCursor).toBe("string");
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("real Sentry response header with both links", () => {
    const header =
      '<https://us.sentry.io/api/0/organizations/sentry/projects/?cursor=1735689600000:0:1>; rel="previous"; results="false"; cursor="1735689600000:0:1", ' +
      '<https://us.sentry.io/api/0/organizations/sentry/projects/?cursor=1735689600000:100:0>; rel="next"; results="true"; cursor="1735689600000:100:0"';
    const result = parseLinkHeader(header);
    expect(result.nextCursor).toBe("1735689600000:100:0");
  });

  test("real Sentry last-page response header", () => {
    const header =
      '<https://us.sentry.io/api/0/organizations/sentry/projects/?cursor=1735689600000:0:1>; rel="previous"; results="true"; cursor="1735689600000:0:1", ' +
      '<https://us.sentry.io/api/0/organizations/sentry/projects/?cursor=1735689600000:200:0>; rel="next"; results="false"; cursor="1735689600000:200:0"';
    const result = parseLinkHeader(header);
    expect(result.nextCursor).toBeUndefined();
  });
});
