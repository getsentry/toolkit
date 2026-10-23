/**
 * Property-based tests for paginate() against models of Sentry's paginators.
 *
 * Earlier pagination tests modeled every cursor as an absolute row offset,
 * which hid a skip bug: Sentry's page-number paginators put the page size in
 * the cursor, so changing `per_page` mid-walk reads the wrong rows. These
 * models port the cursor math from `src/sentry/api/paginator.py`, and the
 * properties walk `-c next` the way the CLI does, asserting that every row is
 * returned exactly once, in order.
 */

import { asyncProperty, assert as fcAssert, integer, nat } from "fast-check";
import { describe, expect, test } from "vitest";
import {
  API_MAX_PER_PAGE,
  type PaginatedResponse,
  paginate,
} from "../../src/lib/api/infrastructure.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

type FetchPage = (
  perPage: number,
  cursor: string | undefined,
) => Promise<PaginatedResponse<number[]>>;

function parseCursor(cursor: string | undefined): [number, number] {
  const [value = 0, offset = 0] = (cursor ?? "0:0:0").split(":").map(Number);
  return [value, offset];
}

/** `GenericOffsetPaginator`: cursor offset is an absolute row offset. */
function genericOffsetPaginator(total: number): FetchPage {
  return (perPage, cursor) => {
    const [, offset] = parseCursor(cursor);
    const end = Math.min(offset + perPage, total);
    const data = Array.from({ length: end - offset }, (_, i) => offset + i);
    return Promise.resolve({
      data,
      nextCursor: end < total ? `0:${end}:0` : undefined,
    });
  };
}

/**
 * `OffsetPaginator`: cursor is `<page size>:<page number>:<is_prev>`.
 *
 * Port of `OffsetPaginator.get_result`, including the window it reads when
 * the cursor's page size differs from the request's `per_page`.
 */
function offsetPaginator(total: number): FetchPage {
  const rows = Array.from({ length: total }, (_, i) => i);
  return (perPage, cursor) => {
    const [value, page] = parseCursor(cursor);
    const limit = Math.min(perPage, API_MAX_PER_PAGE);
    const offset = page * value;
    const stop = offset + (value || limit) + 1;
    let results = rows.slice(offset, stop);
    if (value !== limit) {
      results = results.slice(-(limit + 1));
    }
    return Promise.resolve({
      data: results.slice(0, limit),
      nextCursor: results.length > limit ? `${limit}:${page + 1}:0` : undefined,
    });
  };
}

const paginators = [
  { name: "GenericOffsetPaginator", make: genericOffsetPaginator },
  { name: "OffsetPaginator", make: offsetPaginator },
];

/** Follow `-c next` until the cursor runs out, like repeated CLI calls. */
async function walk(fetchPage: FetchPage, total: number, limit: number) {
  const seen: number[] = [];
  let cursor: string | undefined;
  // Each call returns at least one row while rows remain.
  for (let call = 0; call <= total; call += 1) {
    const result = await paginate({ limit, cursor }, fetchPage);
    expect(result.data.length).toBeLessThanOrEqual(limit);
    seen.push(...result.data);
    if (!result.nextCursor) {
      return seen;
    }
    cursor = result.nextCursor;
  }
  throw new Error("walk did not finish");
}

const totalArb = nat(API_MAX_PER_PAGE * 5);
const limitArb = integer({ min: 1, max: API_MAX_PER_PAGE * 4 });

describe.each(paginators)("property: paginate over $name", ({ make }) => {
  test("returns every row exactly once, in order, across -c next", async () => {
    await fcAssert(
      asyncProperty(totalArb, limitArb, async (total, limit) => {
        const seen = await walk(make(total), total, limit);
        expect(seen).toEqual(Array.from({ length: total }, (_, i) => i));
      }),
      { numRuns: DEFAULT_NUM_RUNS },
    );
  });

  test("fills the limit whenever a page size divides it", async () => {
    await fcAssert(
      asyncProperty(totalArb, limitArb, async (total, limit) => {
        const result = await paginate({ limit }, make(total));
        if (limit <= API_MAX_PER_PAGE || limit % API_MAX_PER_PAGE === 0) {
          expect(result.data).toHaveLength(Math.min(total, limit));
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS },
    );
  });
});
