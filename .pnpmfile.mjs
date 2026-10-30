// @sentry/api/source-analysis loads the classic compiler API through an
// optional typescript peer. TypeScript 7 no longer ships that API, and a peer
// always resolves to the workspace's TypeScript, so give the package
// TypeScript 6 as a dependency of its own instead.
const typescriptApiConsumers = new Set(["@sentry/api"]);

function readPackage(pkg) {
  if (
    typescriptApiConsumers.has(pkg.name) &&
    pkg.peerDependencies?.typescript
  ) {
    delete pkg.peerDependencies.typescript;
    delete pkg.peerDependenciesMeta?.typescript;
    pkg.dependencies = {
      ...pkg.dependencies,
      typescript: "npm:typescript@^6.0.3",
    };
  }
  return pkg;
}

export const hooks = { readPackage };
