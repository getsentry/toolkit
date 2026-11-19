import { MAX_LIST_PAGES } from "@sentry/api/client";
import { describe, expect, it } from "vitest";
import { fetchEveryPage } from "./pagination";

describe("fetchEveryPage", () => {
  it("returns every row in page order", async () => {
    const pages: Record<string, { data: number[]; nextCursor?: string }> = {
      first: { data: [1, 2], nextCursor: "2:1:0" },
      "2:1:0": { data: [3] },
    };

    await expect(
      fetchEveryPage(async (cursor) => pages[cursor ?? "first"]!, "listing"),
    ).resolves.toEqual([1, 2, 3]);
  });

  it("throws when the API repeats a cursor", async () => {
    await expect(
      fetchEveryPage(
        async () => ({ data: [1], nextCursor: "2:1:0" }),
        "listing rows",
      ),
    ).rejects.toThrow("Pagination repeated a cursor when listing rows");
  });

  it("throws instead of returning a partial list at the page cap", async () => {
    let requests = 0;

    await expect(
      fetchEveryPage(async () => {
        requests += 1;
        return { data: [requests], nextCursor: `1:${requests}:0` };
      }, "listing rows"),
    ).rejects.toThrow(
      `Pagination exceeded ${MAX_LIST_PAGES} pages when listing rows`,
    );
    expect(requests).toBe(MAX_LIST_PAGES);
  });
});
