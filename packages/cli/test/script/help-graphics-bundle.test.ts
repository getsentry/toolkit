/**
 * `lib/help.ts` must not import the terminal-image stack: the full CLI
 * registers the kitty/sixel banner from `app.ts`, and `@sentry/mcp-server`
 * (which bundles help but not `app.ts`) leaves it out. See `GraphicsBanner`
 * in `lib/help.ts`.
 */

import { join } from "node:path";
import { build } from "esbuild";
import { expect, test } from "vitest";

const IMAGE_STACK_RE =
  /(?:src[\\/]lib[\\/](?:sixel|sixel-image|kitty-image)\.ts|src[\\/]generated[\\/]banner-image\.ts|node_modules[\\/].*(?:pngjs|jpeg-js)[\\/])/;

test("help does not bundle sixel, kitty, pngjs, or jpeg-js", async () => {
  const { metafile } = await build({
    entryPoints: [join(import.meta.dirname, "../../src/lib/help.ts")],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    packages: "bundle",
    metafile: true,
    logLevel: "silent",
  });
  const inputs = Object.keys(metafile.inputs);
  expect(inputs.some((path) => path.endsWith("lib/help.ts"))).toBe(true);
  expect(inputs.filter((path) => IMAGE_STACK_RE.test(path))).toEqual([]);
});
