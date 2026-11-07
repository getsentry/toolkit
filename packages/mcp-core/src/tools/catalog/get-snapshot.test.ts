import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { mswServer } from "@sentry/mcp-server-mocks";
import getSnapshot from "./get-snapshot.js";
import { getServerContext } from "../../test-setup.js";
import { getSnapshotOutputSchema } from "../support/snapshots/summary.js";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";

type SnapshotContent = ReturnType<typeof getSnapshotOutputSchema.parse>;

function getContent(result: unknown): SnapshotContent {
  assertStructuredOnlyResult(result);
  const content = getStructuredContent<SnapshotContent>(result);
  expect(getSnapshotOutputSchema.parse(content)).toEqual(content);
  return content;
}

const snapshotFixture = {
  project_id: "12345",
  comparison_type: "diff",
  state: "visible",
  vcs_info: {
    head_sha: "abc123def",
    base_sha: "000111222",
    head_ref: "feature/new-login",
    base_ref: "main",
    pr_number: "789",
    repo_name: "getsentry/sentry",
  },
  approval_info: {
    status: "requires_approval",
    is_auto_approved: false,
  },
  images: [],
  changed: [
    {
      head_image: {
        display_name: "login_screen.png",
        group: "auth",
        image_file_name: "snapshots-iphone-16/auth_login_screen.png",
        content_hash: "internal-content-hash",
        image_url: "https://storage.internal.example/auth_login_screen.png",
      },
      diff: 0.125,
    },
  ],
  added: [
    {
      display_name: "new_modal.png",
      group: "dialogs",
      image_file_name: "snapshots-iphone-16/dialogs_new_modal.png",
    },
  ],
  removed: [],
  renamed: [
    {
      head_image: {
        display_name: "settings_page.png",
        group: "settings",
        image_file_name: "snapshots-iphone-16/settings_page.png",
      },
      base_image: {
        display_name: "preferences_page.png",
        group: "settings",
        image_file_name: "snapshots-iphone-16/preferences_page.png",
      },
    },
  ],
  errored: [],
  unchanged: [
    {
      display_name: "unchanged.png",
      group: "stable",
      image_file_name: "snapshots-iphone-16/unchanged.png",
    },
  ],
  skipped: [
    {
      display_name: "skipped.png",
      group: "selective-upload",
      image_file_name: "snapshots-iphone-16/skipped.png",
    },
  ],
  total_count: 5,
  changed_count: 1,
  added_count: 1,
  removed_count: 0,
  renamed_count: 1,
  unchanged_count: 1,
  errored_count: 0,
  skipped_count: 1,
  internal_artifact_state: "internal-only",
};

function setupSnapshotMock(body: Record<string, unknown> = snapshotFixture) {
  mswServer.use(
    http.get(
      "https://sentry.io/api/0/organizations/sentry/preprodartifacts/snapshots/231949/",
      ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("compact_metadata")).toBe("true");
        return HttpResponse.json(body);
      },
      { once: true },
    ),
  );
}

function callHandler(
  overrides: Partial<Parameters<typeof getSnapshot.handler>[0]> = {},
) {
  return getSnapshot.handler(
    {
      organizationSlug: "sentry",
      snapshotId: "231949",
      showUnmodified: false,
      regionUrl: null,
      ...overrides,
    },
    {
      ...getServerContext(),
      availableToolNames: new Set(["get_snapshot_image"]),
      directToolNames: new Set(["get_snapshot_image"]),
    },
  );
}

describe("get_snapshot", () => {
  it("returns compact structured summary", async () => {
    setupSnapshotMock();

    const content = getContent(await callHandler());

    expect(content).toMatchInlineSnapshot(`
      {
        "added": [
          {
            "group": "dialogs",
            "images": [
              {
                "displayName": "new_modal.png",
                "imageFileName": "snapshots-iphone-16/dialogs_new_modal.png",
              },
            ],
          },
        ],
        "approval": {
          "autoApproved": false,
          "status": "requires_approval",
        },
        "changed": [
          {
            "group": "auth",
            "images": [
              {
                "diffPercent": 12.5,
                "displayName": "login_screen.png",
                "imageFileName": "snapshots-iphone-16/auth_login_screen.png",
              },
            ],
          },
        ],
        "comparisonType": "diff",
        "counts": {
          "added": 1,
          "changed": 1,
          "errored": 0,
          "removed": 0,
          "renamed": 1,
          "skipped": 1,
          "total": 5,
          "unchanged": 1,
        },
        "errored": [],
        "organizationSlug": "sentry",
        "projectId": "12345",
        "removed": [],
        "renamed": [
          {
            "group": "settings",
            "images": [
              {
                "displayName": "settings_page.png",
                "imageFileName": "snapshots-iphone-16/settings_page.png",
                "previous": {
                  "displayName": "preferences_page.png",
                  "imageFileName": "snapshots-iphone-16/preferences_page.png",
                },
              },
            ],
          },
        ],
        "responseNotes": [
          "Use the Sentry tool \`get_snapshot_image(organizationSlug='sentry', snapshotId='231949', imageIdentifier='<imageFileName>')\` to view one image preview; pass its imageFileName as imageIdentifier.",
          "Use the Sentry tool \`get_snapshot_image(organizationSlug='sentry', snapshotId='231949', imageIdentifier='<imageFileName>', imageResolution='full')\` to fetch original full-resolution image bytes",
        ],
        "snapshotId": "231949",
        "state": "visible",
        "url": "https://sentry.sentry.io/preprod/snapshots/231949/",
        "vcs": {
          "baseRef": "main",
          "baseSha": "000111222",
          "headRef": "feature/new-login",
          "headSha": "abc123def",
          "prNumber": 789,
          "repoName": "getsentry/sentry",
        },
      }
    `);
    const serialized = JSON.stringify(content);
    expect(serialized).not.toContain("internal-content-hash");
    expect(serialized).not.toContain("storage.internal.example");
    expect(serialized).not.toContain("internal-only");
    expect(serialized).not.toContain("unchanged.png");
    expect(serialized).not.toContain("skipped.png");
  });

  it("points at the selectedSnapshot URL without imageIdentifier when get_snapshot_image is unavailable", async () => {
    setupSnapshotMock();

    const result = await getSnapshot.handler(
      {
        organizationSlug: "sentry",
        snapshotId: "231949",
        showUnmodified: false,
        regionUrl: null,
      },
      {
        ...getServerContext(),
        availableToolNames: new Set(),
        directToolNames: new Set(),
      },
    );

    expect(getContent(result).responseNotes).toEqual([
      'Use the Sentry tool `get_sentry_resource(url="https://sentry.sentry.io/preprod/snapshots/231949/?selectedSnapshot=<URL-encoded imageFileName>")` to view one image preview.',
      "Full-resolution snapshot image bytes are not available in this session",
    ]);
  });

  it("skips non-object entries in image sections", async () => {
    setupSnapshotMock({
      ...snapshotFixture,
      changed: [null, "bogus", ...snapshotFixture.changed],
      added: [42, ...snapshotFixture.added],
    });

    const content = getContent(await callHandler());

    expect(content.changed.flatMap((group) => group.images)).toHaveLength(1);
    expect(content.added.flatMap((group) => group.images)).toHaveLength(1);
  });

  it("throws on missing explicit params", async () => {
    await expect(
      callHandler({
        organizationSlug: null,
        snapshotId: null,
      } as unknown as Partial<Parameters<typeof getSnapshot.handler>[0]>),
    ).rejects.toThrow("Provide both organizationSlug and snapshotId");
  });

  it("lists unchanged and skipped sections when requested", async () => {
    setupSnapshotMock();

    const content = getContent(await callHandler({ showUnmodified: true }));

    expect(content.unchanged).toEqual([
      {
        group: "stable",
        images: [
          {
            imageFileName: "snapshots-iphone-16/unchanged.png",
            displayName: "unchanged.png",
          },
        ],
      },
    ]);
    expect(content.skipped).toEqual([
      {
        group: "selective-upload",
        images: [
          {
            imageFileName: "snapshots-iphone-16/skipped.png",
            displayName: "skipped.png",
          },
        ],
      },
    ]);
  });

  it("hints when compact diff output hides the only file lists", async () => {
    setupSnapshotMock({
      ...snapshotFixture,
      changed: [],
      added: [],
      renamed: [],
      unchanged_count: 1,
      skipped_count: 1,
    });

    const content = getContent(await callHandler());

    expect(content.images).toEqual([]);
    expect(content.unchanged).toBeUndefined();
    expect(content.responseNotes[0]).toBe(
      "No changed images are shown in compact mode. Re-run `get_snapshot` with `showUnmodified=true` to list unchanged and skipped images.",
    );
  });

  it("lists no-diff image inventory when diff sections are empty but images is populated", async () => {
    setupSnapshotMock({
      comparison_type: "diff",
      state: "visible",
      project_id: "12345",
      images: [
        {
          display_name: "No Change Login",
          group: "auth",
          image_file_name: "snapshots-iphone-16/no_change_login.png",
        },
      ],
      changed: [],
      added: [],
      removed: [],
      renamed: [],
      errored: [],
      unchanged: [],
      skipped: [],
      total_count: 1,
    });

    const content = getContent(await callHandler());

    expect(content.images).toEqual([
      {
        group: "auth",
        images: [
          {
            imageFileName: "snapshots-iphone-16/no_change_login.png",
            displayName: "No Change Login",
          },
        ],
      },
    ]);
    expect(content.counts.total).toBe(1);
    expect(content.vcs).toBeNull();
    expect(content.approval).toBeNull();
    expect(content.responseNotes).toHaveLength(2);
  });

  it("lists solo snapshot images and treats showUnmodified as a no-op", async () => {
    setupSnapshotMock({
      comparison_type: "solo",
      state: "visible",
      project_id: "12345",
      images: [
        {
          display_name: "Dark mode",
          group: "Content View",
          image_file_name: "snapshots-ipad/Content_View_Dark_mode.png",
        },
      ],
      changed: [],
      added: [],
      removed: [],
      renamed: [],
      errored: [],
      unchanged: [],
      skipped: [],
      total_count: 1,
      changed_count: 0,
      added_count: 0,
      removed_count: 0,
      renamed_count: 0,
      unchanged_count: 0,
      errored_count: 0,
      skipped_count: 0,
    });

    const content = getContent(await callHandler({ showUnmodified: true }));

    expect(content.images).toEqual([
      {
        group: "Content View",
        images: [
          {
            imageFileName: "snapshots-ipad/Content_View_Dark_mode.png",
            displayName: "Dark mode",
          },
        ],
      },
    ]);
    expect(content.unchanged).toBeUndefined();
    expect(content.skipped).toBeUndefined();
  });
});
