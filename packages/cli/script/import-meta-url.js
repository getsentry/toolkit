// Shim for import.meta.url in CommonJS bundles.
// This file is injected by esbuild during bundling and provides a CJS-compatible
// replacement for import.meta.url, which is undefined in CommonJS context.
// The build script defines `import.meta.url` to be replaced with `import_meta_url`.
export const import_meta_url =
  require("node:url").pathToFileURL(__filename).href;
