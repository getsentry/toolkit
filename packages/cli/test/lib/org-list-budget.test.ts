/**
 * Surplus fetching preserves items, target order, and resume cursors.
 * DSN and alert list command tests cover initial quotas and cursor forwarding.
 */

import { describe, expect, test, vi } from "vitest";
import {
  type FetchResult,
  fetchGroupsWithBudget,
  type GroupFetchOptions,
} from "../../src/lib/org-list.js";

type Page = {
  items: string[];
  hasMore: boolean;
  nextCursor?: string;
};

function page(items: string[], nextCursor?: string): FetchResult<Page> {
  return {
    success: true,
    data: { items, hasMore: !!nextCursor, nextCursor },
  };
}

const adapters = {
  getGroupKey: (group: string) => group,
  getItems: (result: Page) => result.items,
};

describe("fetchGroupsWithBudget", () => {
  test.each([
    "empty",
    "failed",
  ] as const)("redistributes the %s group's unused slots while preserving group order", async (firstGroup) => {
    const first: FetchResult<Page> =
      firstGroup === "empty"
        ? page([])
        : { success: false, error: new Error("Project access denied") };
    const fetchGroup = vi.fn(
      async (group: string, options: GroupFetchOptions) => {
        if (options.startCursor) {
          return page(
            Array.from(
              { length: options.limit },
              (_, index) => `${group}-extra-${index}`
            )
          );
        }
        if (group === "a") {
          return first;
        }
        // Short pages with a cursor remain expandable, as in alert lists.
        return page(
          group === "b" ? ["b-first"] : ["c-0", "c-1", "c-2"],
          `${group}-next`
        );
      }
    );
    const onProgress = vi.fn();
    const result = await fetchGroupsWithBudget(["a", "b", "c"], {
      ...adapters,
      limit: 9,
      fetchGroup,
      onProgress,
    });

    expect(fetchGroup.mock.calls).toEqual([
      ["a", { limit: 3, startCursor: undefined }],
      ["b", { limit: 3, startCursor: undefined }],
      ["c", { limit: 3, startCursor: undefined }],
      ["b", { limit: 3, startCursor: "b-next" }],
      ["c", { limit: 2, startCursor: "c-next" }],
    ]);
    expect(result).toEqual({
      results: [
        first,
        page(["b-first", "b-extra-0", "b-extra-1", "b-extra-2"]),
        page(["c-0", "c-1", "c-2", "c-extra-0", "c-extra-1"]),
      ],
      hasMore: false,
    });
    expect(onProgress.mock.calls).toEqual([[4], [9]]);
  });

  test("retains fetched items and their resume cursor if a surplus fetch fails", async () => {
    const fetchGroup = vi.fn(
      async (
        group: string,
        options: GroupFetchOptions
      ): Promise<FetchResult<Page>> => {
        if (options.startCursor) {
          return { success: false, error: new Error("Surplus fetch failed") };
        }
        return group === "a"
          ? page([])
          : page(["b-first", "b-second"], "b-retry");
      }
    );
    const onProgress = vi.fn();
    const result = await fetchGroupsWithBudget(["a", "b"], {
      ...adapters,
      limit: 4,
      fetchGroup,
      onProgress,
    });

    expect(fetchGroup.mock.calls.at(-1)).toEqual([
      "b",
      { limit: 2, startCursor: "b-retry" },
    ]);
    expect(result).toEqual({
      results: [page([]), page(["b-first", "b-second"], "b-retry")],
      hasMore: true,
    });
    expect(onProgress.mock.calls).toEqual([[2], [2]]);
  });
});
