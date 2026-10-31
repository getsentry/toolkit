#!/usr/bin/env tsx
/**
 * Bundle the CLI's `src/mcp-server.ts` into this package's `dist/sentry-mcp.cjs`.
 *
 * The entry runs the CLI's own runner (`cli.ts`) with a smaller route map:
 * `mcp` (the default command), `auth`, and `help`. So the package ships the
 * same server and the same `auth` commands as the CLI, but none of the other
 * commands. The build fails if anything on {@link FORBIDDEN_INPUTS} reaches
 * the bundle or the output grows past {@link MAX_BUNDLE_BYTES}, so CLI-only
 * code cannot creep in through a new import.
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Metafile, type Plugin } from "esbuild";
import { requireAliasPlugin } from "../../cli/script/lib/require-alias-plugin.js";
import { zodEnglishLocalesPlugin } from "../../cli/script/lib/zod-locales-plugin.js";
import { textImportPlugin } from "../../cli/script/text-import-plugin.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_ROOT = resolve(PACKAGE_ROOT, "../cli");
const OUTFILE = resolve(PACKAGE_ROOT, "dist/sentry-mcp.cjs");

/**
 * Output is 3,689,911 bytes (3.52 MiB) as of the CLI-runner build. The budget
 * leaves about 240 KB for new tools and commands, not enough for a heavy CLI
 * dependency to slip in unnoticed.
 */
const MAX_BUNDLE_BYTES = 3.75 * 1024 * 1024;

/**
 * Inputs that serve the CLI but not this package: commands other than `mcp`,
 * `auth`, and `help`, agent skills, shell completions, syntax highlighting,
 * the Ink UI, `sentry init`, build/sourcemap/debug-file processing, the
 * SQLite WASM fallback for Node.js < 22.15, and MCP SDK v1 (stdio runs on v2).
 */
const FORBIDDEN_INPUTS: ReadonlyArray<RegExp> = [
  /[\\/]packages[\\/]cli[\\/]src[\\/](?:app\.ts$|commands[\\/](?!auth[\\/]|help\.ts$|mcp\.ts$))/,
  /[\\/]packages[\\/]cli[\\/]src[\\/]lib[\\/](?:agent-skills|complete|completions)\.ts$/,
  /[\\/]packages[\\/]cli[\\/]src[\\/]lib[\\/]formatters[\\/]sixel-dashboard\.ts$/,
  /[\\/]packages[\\/]cli[\\/]src[\\/]lib[\\/](?:bash-hook|build|dif|init|react-native|snapshots|sourcemap|wasm)[\\/]/,
  /[\\/]node_modules[\\/](?:cli-highlight|highlight\.js|parse5|ink|ink-spinner|react|react-reconciler|yoga-layout|@sentry[\\/]symbolic|node-sqlite3-wasm)[\\/]/,
  /[\\/]node_modules[\\/](?:zod[\\/]v3|@modelcontextprotocol[\\/]sdk[\\/]dist[\\/]\w+[\\/]server[\\/]mcp\.js)/,
];

/** The bundle requires native `node:sqlite`, which Node.js 22.15 unflagged. */
const NODE_VERSION_CHECK = `{let v=process.versions.node.split(".").map(Number);if(v[0]<22||(v[0]===22&&v[1]<15)){console.error("Error: @sentry/mcp-server requires Node.js 22.15 or later (found "+process.version+").");process.exit(1)}}`;

/**
 * Packages that only CLI-only code paths import: the SQLite WASM fallback
 * (Node.js < 22.15, which the version check rejects), the symbolic WASM
 * binary, and the Ink UI. They resolve to an empty module instead of a
 * `require()` of a package the tarball does not ship, so no dangling import
 * reaches the output.
 *
 * MCP SDK v1's `McpServer` and Zod 3 are stubbed too. mcp-core still imports
 * v1 for `buildServer()`'s default, but stdio asks for v2. `zod/v3` is only
 * imported by v1 and by `@ai-sdk/provider-utils` code that never runs for
 * Zod 4 schemas. The CLI's own bundles keep both (`@mastra/schema-compat`
 * uses Zod 3).
 */
const STUBBED_MODULES =
  /^(?:node-sqlite3-wasm|@sentry\/symbolic\/symbolic_bg\.wasm|ink|ink-spinner|react|react-reconciler|react-devtools-core|yoga-layout|@modelcontextprotocol\/sdk\/server\/mcp\.js|zod\/v3)(?:\/.*)?$/;

const stubModulesPlugin: Plugin = {
  name: "stub-cli-only-modules",
  setup(b) {
    b.onResolve({ filter: STUBBED_MODULES }, (args) => ({
      path: args.path,
      namespace: "stub",
    }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "module.exports = {};",
      loader: "js",
    }));
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
// `packages/cli/script/bump-version.ts`.
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
    // Without it, the CLI falls back to its committed default client ID.
    ...(process.env.SENTRY_CLIENT_ID
      ? { SENTRY_CLIENT_ID_BUILD: JSON.stringify(process.env.SENTRY_CLIENT_ID) }
      : {}),
    "process.env.NODE_ENV": JSON.stringify("production"),
    // Tree-shakes the SDK's runtime module hooks, which can't instrument a
    // bundle.
    __SENTRY_CHANNEL_INJECTION__: "false",
    // Code blocks in help and auth output render without colors, so
    // highlight.js and parse5 stay out (see formatters/highlight.ts).
    __SENTRY_CLI_SYNTAX_HIGHLIGHT__: "false",
    // `auth switch` and `auth login` ask for an account by argument instead
    // of the Ink picker (see lib/select-prompt.ts).
    __SENTRY_CLI_INK_UI__: "false",
    "import.meta.url": "import_meta_url",
  },
  external: ["node:*"],
  metafile: true,
  plugins: [
    stubModulesPlugin,
    textImportPlugin,
    requireAliasPlugin,
    zodEnglishLocalesPlugin,
  ],
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
    `\nError: the @sentry/mcp-server bundle is ${(bytes / 1024 / 1024).toFixed(2)} MB, over the ${(MAX_BUNDLE_BYTES / 1024 / 1024).toFixed(2)} MB budget.\n`,
  );
  process.exit(1);
}

console.log(
  `  -> ${OUTFILE.slice(PACKAGE_ROOT.length + 1)} (${(bytes / 1024).toFixed(1)} KB)`,
);
