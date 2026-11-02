import type { ImageContent, TextContent } from "@modelcontextprotocol/server";
import { mswServer } from "@sentry/mcp-server-mocks";
import { decode as decodePng, encode as encodePng } from "fast-png";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { getServerContext } from "../../test-setup.js";
import getSnapshotImage from "./get-snapshot-image.js";

const fakePng = encodePng({
  width: 1,
  height: 1,
  data: new Uint8Array([255, 0, 0, 255]),
  depth: 8,
  channels: 4,
});
const largeSixteenBitPng = createSolidSixteenBitPng(1200, 600);

function createSolidSixteenBitPng(width: number, height: number): Uint8Array {
  const data = new Uint16Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const offset = pixel * 4;
    data[offset] = 65535;
    data[offset + 1] = 32768;
    data[offset + 2] = 0;
    data[offset + 3] = 65535;
  }

  return encodePng({
    width,
    height,
    data,
    depth: 16,
    channels: 4,
  });
}

const imageIdentifier = "login_screen.png";
const slashImageIdentifier =
  "snapshots-iphone-17e/test_CoffeeProductCards.swift_FeaturedProductCard_Kenya.png";
const imageDetailPath =
  "https://sentry.io/api/0/organizations/sentry/preprodartifacts/snapshots/231949/images/login_screen.png/";
const slashImageDetailPath = `https://sentry.io/api/0/organizations/sentry/preprodartifacts/snapshots/231949/images/${encodeURIComponent(slashImageIdentifier)}/`;
const headDownloadPath =
  "https://sentry.io/api/0/organizations/sentry/preprodartifacts/snapshots/231949/images/head.png/download/";
const baseDownloadPath =
  "https://sentry.io/api/0/organizations/sentry/preprodartifacts/snapshots/231949/images/base.png/download/";
const diffDownloadPath =
  "https://sentry.io/api/0/organizations/sentry/preprodartifacts/snapshots/231949/images/diff.png/download/";

const changedImageDetailFixture = {
  image_file_name: imageIdentifier,
  comparison_status: "changed",
  head_image: {
    display_name: "login_screen.png",
    group: "auth",
    image_file_name: imageIdentifier,
    width: 1080,
    height: 1920,
    image_url:
      "/api/0/organizations/sentry/preprodartifacts/snapshots/231949/images/head.png/download/",
    context: {
      preview: {
        container_display_name: "Auth Login",
      },
      simulator: { device_name: "iPhone 16" },
    },
  },
  base_image: {
    display_name: "login_screen.png",
    group: "auth",
    image_file_name: imageIdentifier,
    width: 1080,
    height: 1920,
    image_url:
      "/api/0/organizations/sentry/preprodartifacts/snapshots/231949/images/base.png/download/",
  },
  diff_image_url:
    "/api/0/organizations/sentry/preprodartifacts/snapshots/231949/images/diff.png/download/",
  diff_percentage: 0.125,
  previous_image_file_name: null,
};

function setupChangedImageMocks(options: { contentType?: string } = {}) {
  mswServer.use(
    http.get(
      imageDetailPath,
      () => HttpResponse.json(changedImageDetailFixture),
      {
        once: true,
      },
    ),
    http.get(
      headDownloadPath,
      () =>
        new HttpResponse(fakePng, {
          headers: { "content-type": options.contentType ?? "image/png" },
        }),
      { once: true },
    ),
    http.get(
      baseDownloadPath,
      () =>
        new HttpResponse(fakePng, { headers: { "content-type": "image/png" } }),
      { once: true },
    ),
    http.get(
      diffDownloadPath,
      () =>
        new HttpResponse(fakePng, { headers: { "content-type": "image/png" } }),
      { once: true },
    ),
  );
}

function callHandler(
  overrides: Partial<Parameters<typeof getSnapshotImage.handler>[0]> = {},
) {
  return getSnapshotImage.handler(
    {
      organizationSlug: "sentry",
      snapshotId: "231949",
      imageIdentifier,
      imageResolution: "preview",
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

function splitParts(parts: (TextContent | ImageContent)[]) {
  return {
    textParts: parts.filter(
      (part): part is TextContent => part.type === "text",
    ),
    imageParts: parts.filter(
      (part): part is ImageContent => part.type === "image",
    ),
  };
}

describe("get_snapshot_image", () => {
  it("returns preview text and image parts for a changed comparison", async () => {
    setupChangedImageMocks();

    const result = (await callHandler()) as (TextContent | ImageContent)[];
    const { textParts, imageParts } = splitParts(result);

    expect(textParts[0]!.text).toContain("## login_screen.png");
    expect(textParts[0]!.text).toContain(
      "- **URL**: https://sentry.sentry.io/preprod/snapshots/231949/?selectedSnapshot=login_screen.png",
    );
    expect(textParts[0]!.text).toContain("**Status**: changed");
    expect(textParts[0]!.text).toContain("**Diff**: 12.5%");
    expect(textParts[0]!.text).toContain("**Image Resolution**: preview");
    expect(textParts[0]!.text).toContain(
      "Use the Sentry tool `get_snapshot_image` for full-resolution image bytes",
    );
    expect(textParts[0]!.text).toContain("### Context");
    expect(textParts[0]!.text).toContain("- **device_name**: iPhone 16");
    expect(textParts[1]!.text).toBe("### Head (current) — preview");
    expect(textParts[2]!.text).toBe("### Base (previous) — preview");
    expect(textParts[3]!.text).toBe("### Diff Mask — preview");
    expect(textParts.map((part) => part.text)).toMatchInlineSnapshot(`
      [
        "## login_screen.png

      - **URL**: https://sentry.sentry.io/preprod/snapshots/231949/?selectedSnapshot=login_screen.png
      - **Status**: changed
      - **Diff**: 12.5%
      - **Image Resolution**: preview
      - **Full Resolution**: Use the Sentry tool \`get_snapshot_image\` for full-resolution image bytes
      - **Display Name**: login_screen.png
      - **Group**: auth
      - **File**: \`login_screen.png\`
      - **Dimensions**: 1080×1920

      ### Context
      - **preview**:
        - **container_display_name**: Auth Login
      - **simulator**:
        - **device_name**: iPhone 16",
        "### Head (current) — preview",
        "### Base (previous) — preview",
        "### Diff Mask — preview",
      ]
    `);
    expect(imageParts).toHaveLength(3);
    expect(imageParts[0]!.mimeType).toBe("image/png");
    expect(imageParts[1]!.mimeType).toBe("image/png");
  });

  it("downsamples 16-bit PNGs in preview responses", async () => {
    mswServer.use(
      http.get(
        imageDetailPath,
        () =>
          HttpResponse.json({
            ...changedImageDetailFixture,
            base_image: null,
            diff_image_url: null,
          }),
        { once: true },
      ),
      http.get(
        headDownloadPath,
        () =>
          new HttpResponse(largeSixteenBitPng, {
            headers: { "content-type": "image/png" },
          }),
        { once: true },
      ),
    );

    const result = (await callHandler()) as (TextContent | ImageContent)[];
    const { textParts, imageParts } = splitParts(result);

    expect(textParts[1]!.text).toBe("### Head (current) — preview");
    expect(imageParts).toHaveLength(1);
    expect(imageParts[0]!.mimeType).toBe("image/png");
    expect(imageParts[0]!.data).not.toBe(
      Buffer.from(largeSixteenBitPng).toString("base64"),
    );

    const decoded = decodePng(Buffer.from(imageParts[0]!.data, "base64"));
    expect(decoded.width).toBe(1024);
    expect(decoded.height).toBe(512);
    expect(decoded.depth).toBe(8);
  });

  it("returns original bytes when full resolution is requested", async () => {
    setupChangedImageMocks();

    const result = (await callHandler({
      imageResolution: "full",
    })) as (TextContent | ImageContent)[];
    const { textParts, imageParts } = splitParts(result);

    expect(textParts[0]!.text).toContain("**Image Resolution**: full");
    expect(textParts[1]!.text).toBe("### Head (current) — full");
    expect(imageParts[0]!.data).toBe(Buffer.from(fakePng).toString("base64"));
    expect(imageParts[1]!.data).toBe(Buffer.from(fakePng).toString("base64"));
  });

  it("throws on missing explicit snapshot params", async () => {
    await expect(
      callHandler({
        organizationSlug: null,
        snapshotId: null,
      } as unknown as Partial<Parameters<typeof getSnapshotImage.handler>[0]>),
    ).rejects.toThrow("Provide both organizationSlug and snapshotId");
  });

  it("does not return full image bytes when preview generation fails", async () => {
    const invalidPng = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    mswServer.use(
      http.get(
        imageDetailPath,
        () => HttpResponse.json(changedImageDetailFixture),
        {
          once: true,
        },
      ),
      http.get(
        headDownloadPath,
        () =>
          new HttpResponse(invalidPng, {
            headers: { "content-type": "image/png" },
          }),
        { once: true },
      ),
      http.get(
        baseDownloadPath,
        () =>
          new HttpResponse(invalidPng, {
            headers: { "content-type": "image/png" },
          }),
        { once: true },
      ),
      http.get(
        diffDownloadPath,
        () =>
          new HttpResponse(invalidPng, {
            headers: { "content-type": "image/png" },
          }),
        { once: true },
      ),
    );

    const result = (await callHandler()) as (TextContent | ImageContent)[];
    const { textParts, imageParts } = splitParts(result);

    expect(textParts[1]!.text).toBe(
      "### Head (current) — preview unavailable. Retry with imageResolution=full to fetch the original image.",
    );
    expect(imageParts).toHaveLength(0);
  });

  it("supports slash-containing image identifiers", async () => {
    mswServer.use(
      http.get(
        slashImageDetailPath,
        () =>
          HttpResponse.json({
            ...changedImageDetailFixture,
            image_file_name: slashImageIdentifier,
            head_image: {
              ...changedImageDetailFixture.head_image,
              image_file_name: slashImageIdentifier,
            },
            base_image: null,
            diff_image_url: null,
          }),
        { once: true },
      ),
      http.get(
        headDownloadPath,
        () =>
          new HttpResponse(fakePng, {
            headers: { "content-type": "image/png" },
          }),
        { once: true },
      ),
    );

    const result = (await callHandler({
      imageIdentifier: slashImageIdentifier,
    })) as (TextContent | ImageContent)[];
    const { textParts } = splitParts(result);

    expect(textParts[0]!.text).toContain(`## ${slashImageIdentifier}`);
    expect(textParts[0]!.text).toContain(
      `- **File**: \`${slashImageIdentifier}\``,
    );
  });

  it("detects image type from magic bytes when content-type is octet-stream", async () => {
    setupChangedImageMocks({ contentType: "application/octet-stream" });

    const result = (await callHandler()) as (TextContent | ImageContent)[];
    const { imageParts } = splitParts(result);

    expect(imageParts[0]!.mimeType).toBe("image/png");
  });

  it("throws when no image data is available", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry/preprodartifacts/snapshots/231949/images/missing.png/",
        () =>
          HttpResponse.json({
            image_file_name: "missing.png",
            comparison_status: null,
            head_image: null,
            base_image: null,
            diff_image_url: null,
            diff_percentage: null,
            previous_image_file_name: null,
          }),
        { once: true },
      ),
    );

    await expect(
      callHandler({ imageIdentifier: "missing.png" }),
    ).rejects.toThrow("No image data returned");
  });
});
