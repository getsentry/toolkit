/**
 * Property-based tests for paginate() against models of Sentry's paginators.
 *
 * Earlier pagination tests modeled every cursor as an absolute row offset,
 * which hid a skip bug: Sentry's page-number paginators put the page size in
 * the cursor, so changing `per_page` mid-walk reads the wrong rows. These
 * models port the cursor math from `src/sentry/api/paginator.py`, and the
 * properties walk `-c next` the way the CLI does — with a different
 * `--limit` on every call — asserting that every row is returned exactly
 * once, in order.
 */

import {
  array,
  asyncProperty,
  assert as fcAssert,
  integer,
  nat,
} from "fast-check";
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

/** A server that ignores `per_page` and always serves pages of 30 rows. */
function fixedPageServer(total: number): FetchPage {
  return (_perPage, cursor) => genericOffsetPaginator(total)(30, cursor);
}

const paginators = [
  { name: "GenericOffsetPaginator", make: genericOffsetPaginator },
  { name: "OffsetPaginator", make: offsetPaginator },
  { name: "a server that ignores per_page", make: fixedPageServer },
];

/**
 * Follow `-c next` until the cursor runs out, like repeated CLI calls, using
 * the next limit from `limits` (cycled) on each call.
 */
async function walk(
  fetchPage: FetchPage,
  total: number,
  limits: number[],
  start?: string,
) {
  const seen: number[] = [];
  let cursor = start;
  // Each call returns at least one row while rows remain.
  for (let call = 0; call <= total; call += 1) {
    const limit = limits[call % limits.length] ?? 1;
    const result = await paginate({ limit, cursor }, fetchPage);
    // A resumed walk keeps its first page size, so a much larger later limit
    // can stop at MAX_PAGINATION_PAGES; it must still make progress.
    expect(result.data.length).toBeLessThanOrEqual(limit);
    if (seen.length < total) {
      expect(result.data.length).toBeGreaterThan(0);
    }
    seen.push(...result.data);
    if (!result.nextCursor) {
      return seen;
    }
    cursor = result.nextCursor;
  }
  throw new Error("walk did not finish");
}

const totalArb = nat(API_MAX_PER_PAGE * 5);
const limitsArb = array(integer({ min: 1, max: API_MAX_PER_PAGE * 4 }), {
  minLength: 1,
  maxLength: 4,
});

describe.each(paginators)("property: paginate over $name", ({ make }) => {
  test("fills the limit on a fresh walk", async () => {
    await fcAssert(
      asyncProperty(totalArb, limitsArb, async (total, [limit = 1]) => {
        const result = await paginate({ limit }, make(total));
        expect(result.data).toEqual(
          Array.from({ length: Math.min(limit, total) }, (_, i) => i),
        );
      }),
      { numRuns: DEFAULT_NUM_RUNS },
    );
  });

  test("returns every row exactly once, in order, across -c next", async () => {
    await fcAssert(
      asyncProperty(totalArb, limitsArb, async (total, limits) => {
        const seen = await walk(make(total), total, limits);
        expect(seen).toEqual(Array.from({ length: total }, (_, i) => i));
      }),
      { numRuns: DEFAULT_NUM_RUNS },
    );
  });
});

test("property: a pasted OffsetPaginator cursor resumes without skipping", async () => {
  await fcAssert(
    asyncProperty(
      integer({ min: 1, max: API_MAX_PER_PAGE }),
      integer({ min: 1, max: 5 }),
      nat(API_MAX_PER_PAGE * 3),
      limitsArb,
      async (pageSize, page, extra, limits) => {
        // A cursor as the API returned it, from a walk with another page size.
        const start = pageSize * page;
        const seen = await walk(
          offsetPaginator(start + extra),
          extra,
          limits,
          `${pageSize}:${page}:0`,
        );
        expect(seen).toEqual(
          Array.from({ length: extra }, (_, i) => start + i),
        );
      },
    ),
    { numRuns: DEFAULT_NUM_RUNS },
  );
});

test("property: a fresh walk uses the fewest requests without overfetching", async () => {
  await fcAssert(
    asyncProperty(
      integer({ min: 1, max: API_MAX_PER_PAGE * 10 }),
      async (limit) => {
        const requested: number[] = [];
        const fetchPage = genericOffsetPaginator(limit * 2);
        await paginate({ limit }, (perPage, cursor) => {
          requested.push(perPage);
          return fetchPage(perPage, cursor);
        });
        // e.g. 201 rows: 3 requests of 67, not 100 + 100 + 100.
        const requests = Math.ceil(limit / API_MAX_PER_PAGE);
        expect(requested).toHaveLength(requests);
        const fetched = requested.reduce((sum, perPage) => sum + perPage, 0);
        expect(fetched - limit).toBeLessThan(requests);
      },
    ),
    { numRuns: DEFAULT_NUM_RUNS },
  );
});
