import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { unstable_readConfig } from "wrangler";

describe("docs-mcp deployment configuration", () => {
  test("preserves the existing private Worker", () => {
    const config = unstable_readConfig({
      config: fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url)),
    });

    expect(config.name).toBe("docs-mcp");
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
  });
});
