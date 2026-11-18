// pnpm install hooks. Keep each change narrow and say when it can go.

// TypeScript 7 has no JavaScript compiler API. These packages import
// `typescript` for its compiler API through an optional peer, which resolves
// to the workspace's TypeScript 7. Give them the TypeScript 6 API instead.
// Remove an entry once the package supports TypeScript 7 or TypeScript 7.1
// ships its API.
const TYPESCRIPT6_API = "npm:@typescript/typescript6@6.0.2";
const NEEDS_TYPESCRIPT6_API = new Set([
  // `@sentry/api/source-analysis`, used by CLI command-analysis scripts.
  "@sentry/api",
]);

// Type-aware lint runs on `tsrs-lint` from the `tsrs` package. pnpm installs
// oxlint's optional `oxlint-tsgolint` peer anyway, leaving a second backend
// that nothing runs. Remove this once oxlint drops that peer.
const UNUSED_OXLINT_PEER = "oxlint-tsgolint";

function readPackage(pkg) {
  if (NEEDS_TYPESCRIPT6_API.has(pkg.name) && pkg.peerDependencies?.typescript) {
    delete pkg.peerDependencies.typescript;
    delete pkg.peerDependenciesMeta?.typescript;
    pkg.dependencies = { ...pkg.dependencies, typescript: TYPESCRIPT6_API };
  }
  if (pkg.name === "oxlint" && pkg.peerDependencies?.[UNUSED_OXLINT_PEER]) {
    delete pkg.peerDependencies[UNUSED_OXLINT_PEER];
    delete pkg.peerDependenciesMeta?.[UNUSED_OXLINT_PEER];
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
