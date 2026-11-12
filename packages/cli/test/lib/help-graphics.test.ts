/**
 * Help's kitty/sixel image banner is registered by the full CLI (`app.ts`),
 * not imported by `lib/help.ts`, so `@sentry/mcp-server` can leave the image
 * code out of its bundle. These tests pin that wiring.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const IMAGE = "<graphics-banner>";

vi.mock("../../src/lib/sixel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/sixel.js")>()),
  graphicsBanner: vi.fn(() => IMAGE),
  graphicsBannerExtraRows: vi.fn(() => 2),
}));

// Registers the route map and, with it, the image banner.
await import("../../src/app.js");
const sixel = await import("../../src/lib/sixel.js");
const { printCustomHelp, setGraphicsBanner } =
  await import("../../src/lib/help.js");

/** A row of the block-art banner (see lib/banner.ts). */
const BLOCK_ART = "███";

describe("help graphics banner", () => {
  let savedTty = process.stdout.isTTY;

  beforeEach(() => {
    savedTty = process.stdout.isTTY;
    process.stdout.isTTY = true;
    vi.mocked(sixel.graphicsBanner).mockClear();
  });

  afterEach(() => {
    process.stdout.isTTY = savedTty;
    setGraphicsBanner({
      render: sixel.graphicsBanner,
      extraRows: sixel.graphicsBannerExtraRows,
    });
  });

  test("the CLI app registers the kitty/sixel banner", () => {
    const output = printCustomHelp();
    expect(sixel.graphicsBanner).toHaveBeenCalledOnce();
    expect(output).toContain(IMAGE);
    expect(output).not.toContain(BLOCK_ART);
  });

  test("without a registered banner, help shows the block-art banner", () => {
    setGraphicsBanner(undefined);
    const output = printCustomHelp();
    expect(sixel.graphicsBanner).not.toHaveBeenCalled();
    expect(output).not.toContain(IMAGE);
    expect(output).toContain(BLOCK_ART);
  });
});
