import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { mswServer } from "@sentry/mcp-server-mocks";
import getLatestBaseSnapshot, {
  getLatestBaseSnapshotOutputSchema,
} from "./get-latest-base-snapshot.js";
import { getServerContext } from "../../test-setup.js";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";

type LatestBaseSnapshotContent = ReturnType<
  typeof getLatestBaseSnapshotOutputSchema.parse
>;

function getContent(result: unknown): LatestBaseSnapshotContent {
  assertStructuredOnlyResult(result);
  const content = getStructuredContent<LatestBaseSnapshotContent>(result);
  expect(getLatestBaseSnapshotOutputSchema.parse(content)).toEqual(content);
  return content;
}

const latestBaseFixture = {
  id: "232800",
  project_id: "12345",
  app_info: {
    app_id: "com.emergetools.hackernews",
    name: "HackerNews",
    platform: "ios",
  },
  vcs_info: {
    head_sha: "abc123def456",
    head_ref: "main",
  },
  images: [
    {
      display_name: "Home Screen",
      group: "Main",
      image_file_name: "snapshots-iphone/main_home_screen.png",
      description: "Home screen view",
      content_hash: "internal-content-hash",
      image_url: "https://storage.internal.example/main_home_screen.png",
    },
    {
      display_name: "Settings",
      group: "Settings",
      image_file_name: "snapshots-iphone/settings_page.png",
      description: "Settings page",
    },
  ],
};

describe("get_latest_base_snapshot", () => {
  it("returns curated markdown from latest base build", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry/preprodartifacts/snapshots/latest-base/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("app_id")).toBe(
            "com.emergetools.hackernews",
          );
          expect(url.searchParams.get("compact_metadata")).toBe("true");
          return HttpResponse.json(latestBaseFixture);
        },
        { once: true },
      ),
    );

    const result = await getLatestBaseSnapshot.handler(
      {
        organizationSlug: "sentry",
        appId: "com.emergetools.hackernews",
        branch: null,
        project: null,
        regionUrl: null,
      },
      getServerContext(),
    );
    const content = getContent(result);
    expect(content).toMatchInlineSnapshot(`
      {
        "app": {
          "name": "HackerNews",
          "platform": "ios",
        },
        "appId": "com.emergetools.hackernews",
        "images": [
          {
            "description": "Home screen view",
            "displayName": "Home Screen",
            "group": "Main",
            "imageFileName": "snapshots-iphone/main_home_screen.png",
          },
          {
            "description": "Settings page",
            "displayName": "Settings",
            "group": "Settings",
            "imageFileName": "snapshots-iphone/settings_page.png",
          },
        ],
        "organizationSlug": "sentry",
        "responseNotes": [
          "To view a specific image, use \`get_sentry_resource(url="https://sentry.sentry.io/preprod/snapshots/232800/?selectedSnapshot=<image_file_name>")\`.",
        ],
        "snapshotId": "232800",
        "totalImages": 2,
        "url": "https://sentry.sentry.io/preprod/snapshots/232800/",
        "vcs": {
          "headRef": "main",
          "headSha": "abc123def456",
        },
      }
    `);
    const serialized = JSON.stringify(content);
    expect(serialized).not.toContain("internal-content-hash");
    expect(serialized).not.toContain("storage.internal.example");
    expect(serialized).not.toContain("project_id");
    expect(serialized).not.toContain("app_info");
  });

  it("returns every image in a large latest-base snapshot", async () => {
    const largeLatestBaseFixture = {
      ...latestBaseFixture,
      images: [
        {
          display_name: "Kenya",
          group: "FeaturedProductCard",
          image_file_name:
            "snapshots-iphone-17e/test_CoffeeProductCards.swift_FeaturedProductCard_Kenya.png",
        },
        {
          display_name: "Ethiopia",
          group: "FeaturedProductCard",
          image_file_name:
            "snapshots-iphone-17e/test_CoffeeProductCards.swift_FeaturedProductCard_Ethiopia.png",
        },
        {
          display_name: "Kenya",
          group: "FeaturedProductCard",
          image_file_name:
            "snapshots-iphone-17-pro-max/test_CoffeeProductCards.swift_FeaturedProductCard_Kenya.png",
        },
      ],
    };

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry/preprodartifacts/snapshots/latest-base/",
        () => HttpResponse.json(largeLatestBaseFixture),
        { once: true },
      ),
    );

    const result = await getLatestBaseSnapshot.handler(
      {
        organizationSlug: "sentry",
        appId: "com.emergetools.hackernews",
        branch: null,
        project: null,
        regionUrl: null,
      },
      getServerContext(),
    );
    const content = getContent(result);

    expect(content.totalImages).toBe(3);
    expect(content.images.map((image) => image.imageFileName)).toEqual([
      "snapshots-iphone-17e/test_CoffeeProductCards.swift_FeaturedProductCard_Kenya.png",
      "snapshots-iphone-17e/test_CoffeeProductCards.swift_FeaturedProductCard_Ethiopia.png",
      "snapshots-iphone-17-pro-max/test_CoffeeProductCards.swift_FeaturedProductCard_Kenya.png",
    ]);
  });

  it("keeps PR numbers the snapshot API sends as strings", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry/preprodartifacts/snapshots/latest-base/",
        () =>
          HttpResponse.json({
            ...latestBaseFixture,
            vcs_info: { ...latestBaseFixture.vcs_info, pr_number: "789" },
          }),
        { once: true },
      ),
    );

    const result = await getLatestBaseSnapshot.handler(
      {
        organizationSlug: "sentry",
        appId: "com.emergetools.hackernews",
        branch: null,
        project: null,
        regionUrl: null,
      },
      getServerContext(),
    );
    expect(getContent(result).vcs?.prNumber).toBe(789);
  });

  it("passes project slug to latest-base endpoint", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry/preprodartifacts/snapshots/latest-base/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("projectSlug")).toBe("internal");
          expect(url.searchParams.get("project")).toBeNull();
          return HttpResponse.json(latestBaseFixture);
        },
        { once: true },
      ),
    );

    const result = await getLatestBaseSnapshot.handler(
      {
        organizationSlug: "sentry",
        appId: "com.emergetools.hackernews",
        branch: null,
        project: "internal",
        regionUrl: null,
      },
      getServerContext(),
    );
    expect(getContent(result).snapshotId).toBe("232800");
  });

  it("passes numeric project ID directly to endpoint", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry/preprodartifacts/snapshots/latest-base/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("project")).toBe("1");
          expect(url.searchParams.get("projectSlug")).toBeNull();
          return HttpResponse.json(latestBaseFixture);
        },
        { once: true },
      ),
    );

    const result = await getLatestBaseSnapshot.handler(
      {
        organizationSlug: "sentry",
        appId: "com.emergetools.hackernews",
        branch: null,
        project: "1",
        regionUrl: null,
      },
      getServerContext(),
    );
    expect(getContent(result).snapshotId).toBe("232800");
  });

  it("passes branch filter to endpoint", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry/preprodartifacts/snapshots/latest-base/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("branch")).toBe("main");
          return HttpResponse.json(latestBaseFixture);
        },
        { once: true },
      ),
    );

    const result = await getLatestBaseSnapshot.handler(
      {
        organizationSlug: "sentry",
        appId: "com.emergetools.hackernews",
        branch: "main",
        project: null,
        regionUrl: null,
      },
      getServerContext(),
    );
    expect(getContent(result).snapshotId).toBe("232800");
  });

  it("handles empty images array", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry/preprodartifacts/snapshots/latest-base/",
        () =>
          HttpResponse.json({
            id: "232801",
            images: [],
            app_info: { app_id: "com.test.app", name: "Test" },
          }),
        { once: true },
      ),
    );

    const result = await getLatestBaseSnapshot.handler(
      {
        organizationSlug: "sentry",
        appId: "com.test.app",
        branch: null,
        project: null,
        regionUrl: null,
      },
      getServerContext(),
    );
    const content = getContent(result);
    expect(content.totalImages).toBe(0);
    expect(content.images).toEqual([]);
    expect(content.vcs).toBeNull();
    expect(content.app).toEqual({ name: "Test", platform: null });
  });
});
