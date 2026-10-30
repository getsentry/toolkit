#!/usr/bin/env tsx
/**
 * Bundle `src/mcp-server.ts` into the standalone `@sentry/mcp-server` package.
 *
 * The package runs the same server as `sentry mcp` but ships only what the
 * server needs: the MCP tools, the API client, and the CLI's auth. The build
 * fails if anything on {@link FORBIDDEN_INPUTS} reaches the bundle or the
 * output grows past {@link MAX_BUNDLE_BYTES}, so CLI-only code cannot creep in
 * through a new import.
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Metafile, type Plugin } from "esbuild";
import { requireAliasPlugin } from "./lib/require-alias-plugin.js";
import { textImportPlugin } from "./text-import-plugin.js";

const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_ROOT = resolve(CLI_ROOT, "../mcp-server");
const OUTFILE = resolve(PACKAGE_ROOT, "dist/sentry-mcp.cjs");

/**
 * Current output is about 3.6 MB. The budget leaves room for new tools without
 * letting a heavy CLI dependency slip in unnoticed.
 */
const MAX_BUNDLE_BYTES = 4.5 * 1024 * 1024;

/**
 * The login flow's only markdown use is two inline hints, so the bundle swaps
 * the renderer for a plain-text version. esbuild fails the build if the swap
 * lacks an export that some importer needs.
 */
const MARKDOWN_MODULE = resolve(CLI_ROOT, "src/lib/formatters/markdown.ts");
const PLAIN_MARKDOWN_MODULE = resolve(
  CLI_ROOT,
  "src/lib/formatters/markdown-plain.ts",
);

/**
 * Inputs that serve the CLI but not the MCP server: CLI commands, markdown
 * rendering, agent skills, shell completions, terminal images, the Ink UI,
 * `sentry init`, build/sourcemap/debug-file processing, and the SQLite WASM
 * fallback for Node.js < 22.15.
 */
const FORBIDDEN_INPUTS: ReadonlyArray<RegExp> = [
  /[\\/]packages[\\/]cli[\\/]src[\\/](?:app\.ts|commands[\\/])/,
  /[\\/]packages[\\/]cli[\\/]src[\\/]lib[\\/](?:agent-skills|banner|complete|completion-target|completions|kitty-image|sixel|sixel-image)\.ts$/,
  /[\\/]packages[\\/]cli[\\/]src[\\/]lib[\\/]formatters[\\/](?:markdown|pixel-canvas|sixel-dashboard|sixel-timeseries)\.ts$/,
  /[\\/]packages[\\/]cli[\\/]src[\\/]lib[\\/](?:bash-hook|build|dif|init|react-native|snapshots|sourcemap|wasm)[\\/]/,
  /[\\/]node_modules[\\/](?:cli-highlight|highlight\.js|marked|parse5|ink|ink-spinner|react|react-reconciler|yoga-layout|@sentry[\\/]symbolic|node-sqlite3-wasm)[\\/]/,
];

/** The bundle requires native `node:sqlite`, which Node.js 22.15 unflagged. */
const NODE_VERSION_CHECK = `{let v=process.versions.node.split(".").map(Number);if(v[0]<22||(v[0]===22&&v[1]<15)){console.error("Error: @sentry/mcp-server requires Node.js 22.15 or later (found "+process.version+").");process.exit(1)}}`;

const plainMarkdownPlugin: Plugin = {
  name: "plain-markdown",
  setup(b) {
    b.onResolve({ filter: /[\\/]markdown\.js$/ }, (args) =>
      resolve(args.resolveDir, args.path.replace(/\.js$/, ".ts")) ===
      MARKDOWN_MODULE
        ? { path: PLAIN_MARKDOWN_MODULE }
        : undefined,
    );
  },
};

/** Inputs on {@link FORBIDDEN_INPUTS} that contribute code to the output. */
function findForbiddenInputs(metafile: Metafile): string[] {
  return Object.values(metafile.outputs)
    .flatMap((output) => Object.entries(output.inputs))
    .filter(([, { bytesInOutput }]) => bytesInOutput > 0)
    .map(([input]) => resolve(CLI_ROOT, input))
    .filter((input) => FORBIDDEN_INPUTS.some((pattern) => pattern.test(input)));
}

const pkg = JSON.parse(
  await readFile(resolve(PACKAGE_ROOT, "package.json"), "utf-8"),
) as { version: string };
const cliPkg = JSON.parse(
  await readFile(resolve(CLI_ROOT, "package.json"), "utf-8"),
) as { version: string };

// Each CLI release publishes this package at the CLI's version, set by
// `script/bump-version.ts`.
if (pkg.version !== cliPkg.version) {
  console.error(
    `\nError: @sentry/mcp-server is at ${pkg.version} but the CLI is at ${cliPkg.version}. Both must share one version.\n`,
  );
  process.exit(1);
}

console.log(`\nBundling @sentry/mcp-server v${pkg.version}`);

await mkdir(dirname(OUTFILE), { recursive: true });
const result = await build({
  absWorkingDir: CLI_ROOT,
  entryPoints: ["./src/mcp-server.ts"],
  outfile: OUTFILE,
  bundle: true,
  minify: true,
  treeShaking: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  banner: { js: `#!/usr/bin/env node\n${NODE_VERSION_CHECK}` },
  inject: ["./script/import-meta-url.js"],
  define: {
    SENTRY_CLI_VERSION: JSON.stringify(cliPkg.version),
    SENTRY_MCP_SERVER_VERSION: JSON.stringify(pkg.version),
    // Without it, the CLI falls back to its committed default client ID.
    ...(process.env.SENTRY_CLIENT_ID
      ? { SENTRY_CLIENT_ID_BUILD: JSON.stringify(process.env.SENTRY_CLIENT_ID) }
      : {}),
    "process.env.NODE_ENV": JSON.stringify("production"),
    // Tree-shakes the SDK's runtime module hooks, which can't instrument a
    // bundle.
    __SENTRY_CHANNEL_INJECTION__: "false",
    "import.meta.url": "import_meta_url",
  },
  external: [
    "node:*",
    // Only reachable on Node.js < 22.15, which the version check rejects.
    "node-sqlite3-wasm",
    "@sentry/symbolic/symbolic_bg.wasm",
    "ink",
    "ink-spinner",
    "react",
    "react/*",
    "react-reconciler",
    "react-reconciler/*",
    "react-devtools-core",
    "yoga-layout",
  ],
  metafile: true,
  plugins: [plainMarkdownPlugin, textImportPlugin, requireAliasPlugin],
});

const forbidden = findForbiddenInputs(result.metafile);
if (forbidden.length > 0) {
  console.error(
    "\nError: CLI-only modules reached the @sentry/mcp-server bundle:",
  );
  for (const input of forbidden) {
    console.error(`  ${input}`);
  }
  console.error("Keep these imports out of the MCP server's import graph.\n");
  process.exit(1);
}

const bytes = Object.values(result.metafile.outputs).reduce(
  (total, output) => total + output.bytes,
  0,
);
if (bytes > MAX_BUNDLE_BYTES) {
  console.error(
    `\nError: the @sentry/mcp-server bundle is ${(bytes / 1024 / 1024).toFixed(2)} MB, over the ${(MAX_BUNDLE_BYTES / 1024 / 1024).toFixed(1)} MB budget.\n`,
  );
  process.exit(1);
}

console.log(
  `  -> ${OUTFILE.slice(PACKAGE_ROOT.length + 1)} (${(bytes / 1024).toFixed(1)} KB)`,
);
