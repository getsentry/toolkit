/**
 * Tests for the esbuild plugin that stubs `zod/v3`.
 *
 * Bundles the real dependency that imports `zod/v3` (`@ai-sdk/provider-utils`)
 * with the plugin, runs the code path the MCP server uses, and checks that no
 * Zod 3 module reaches the output.
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, describe, expect, test } from "vitest";
import { zodV3StubPlugin } from "../../script/lib/zod-v3-stub-plugin.js";

const require = createRequire(import.meta.url);
const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), "../..");
/** mcp-core depends on `@ai-sdk/provider-utils`, the copy MCP bundles use. */
const MCP_CORE_DIR = join(CLI_DIR, "../mcp-core");

const PROVIDER_UTILS_ENTRY = `
import { zodSchema } from "@ai-sdk/provider-utils";
import { z } from "zod";
import { ZodFirstPartyTypeKind } from "zod/v3";

export async function run() {
  const schema = zodSchema(z.object({ name: z.string() }));
  let zod3Error;
  try {
    ZodFirstPartyTypeKind.ZodAny;
  } catch (error) {
    zod3Error = error.message;
  }
  return {
    jsonSchema: await schema.jsonSchema,
    validated: await schema.validate({ name: "ok" }),
    zod3Error,
  };
}
`;

const outDir = mkdtempSync(join(tmpdir(), "zod-v3-stub-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

/** Bundle `contents` with the stub, then load and run its `run()` export. */
async function bundleAndRun(
  name: string,
  contents: string,
  resolveDir: string,
): Promise<{ inputs: string[]; result: Record<string, unknown> }> {
  const result = await build({
    stdin: { contents, resolveDir, loader: "js" },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    metafile: true,
    logLevel: "silent",
    plugins: [zodV3StubPlugin],
  });
  const file = join(outDir, `${name}.cjs`);
  writeFileSync(file, result.outputFiles[0]?.text ?? "");
  const mod = require(file) as { run: () => Promise<Record<string, unknown>> };
  return {
    inputs: Object.keys(result.metafile.inputs),
    result: await mod.run(),
  };
}

describe("zodV3StubPlugin", () => {
  test("keeps the AI SDK's Zod 4 schemas working", async () => {
    const { inputs, result } = await bundleAndRun(
      "provider-utils",
      PROVIDER_UTILS_ENTRY,
      MCP_CORE_DIR,
    );

    expect(
      inputs.filter((input) => /[\\/]zod[\\/]v3[\\/]/.test(input)),
    ).toEqual([]);
    expect(result.jsonSchema).toMatchObject({
      type: "object",
      properties: { name: { type: "string" } },
    });
    expect(result.validated).toEqual({ success: true, value: { name: "ok" } });
    expect(result.zod3Error).toBe(
      "Zod 3 schemas are not supported in this build (zod/v3 is not bundled).",
    );
  });
});
