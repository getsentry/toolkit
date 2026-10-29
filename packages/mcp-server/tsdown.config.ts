import { defineConfig } from "tsdown";

// Bundle the MCP SDK into one self-contained file, so installing the proxy
// pulls no runtime dependencies (the SDK alone brings ~95 packages).
export default defineConfig({
  entry: { "sentry-mcp": "bin/sentry-mcp.js" },
  format: ["esm"],
  platform: "node",
  target: "node22.13",
  outDir: "dist",
  clean: true,
  minify: false,
});
