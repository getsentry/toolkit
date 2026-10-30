import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/**/*.ts"],
  format: ["cjs", "esm"], // Build for commonJS and ESmodules
  // Keep .js/.cjs names; package.json exports point at them.
  fixedExtension: false,
  dts: true, // Generate declaration file (.d.ts)
  sourcemap: true,
  clean: true,
  deps: {
    // Load fixtures at runtime from a copy next to the output instead of
    // inlining them. Rolldown's JSON parser rejects trace.json's nesting, and
    // tsgo cannot emit declarations for JSON modules.
    neverBundle: [/^\.\/fixtures\/[^/]+\.json$/],
  },
  copy: { from: "src/fixtures/*.json", to: "dist/fixtures" },
});
