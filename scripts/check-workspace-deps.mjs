/**
 * Fails when workspace package manifests break the dependency direction.
 *
 * The CLI hosts the MCP server, so `sentry` depends on `@sentry/mcp-core`,
 * which depends on `@sentry/toolkit-core`. The reverse edges would create a
 * package cycle, so they are rejected here, along with any other cycle between
 * workspace packages. See docs/architecture/overview.md.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

/** Packages that must never reach the listed packages, even transitively. */
export const FORBIDDEN_DEPENDENCIES = {
  "@sentry/toolkit-core": ["sentry", "@sentry/mcp-core"],
  "@sentry/mcp-core": ["sentry", "@sentry/mcp-cloudflare"],
};

/**
 * Build the workspace-internal dependency graph.
 *
 * @param {{ name: string, [field: string]: unknown }[]} manifests
 * @returns {Map<string, string[]>}
 */
export function buildGraph(manifests) {
  const names = new Set(manifests.map(({ name }) => name));
  return new Map(
    manifests.map((manifest) => [
      manifest.name,
      [
        ...new Set(
          DEPENDENCY_FIELDS.flatMap((field) =>
            Object.keys(manifest[field] ?? {}),
          ).filter((dependency) => names.has(dependency)),
        ),
      ].sort(),
    ]),
  );
}

/**
 * Find dependency cycles, each reported once as a closed path.
 *
 * @param {Map<string, string[]>} graph
 * @returns {string[][]}
 */
export function findCycles(graph) {
  const cycles = [];
  const seen = new Set();
  const state = new Map();
  const stack = [];

  function visit(name) {
    state.set(name, "visiting");
    stack.push(name);
    for (const dependency of graph.get(name) ?? []) {
      if (state.get(dependency) === "visiting") {
        const cycle = [...stack.slice(stack.indexOf(dependency)), dependency];
        const key = cycle
          .slice(0, -1)
          .toSorted((a, b) => a.localeCompare(b))
          .join("\0");
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      } else if (!state.has(dependency)) {
        visit(dependency);
      }
    }
    stack.pop();
    state.set(name, "done");
  }

  for (const name of [...graph.keys()].sort()) {
    if (!state.has(name)) {
      visit(name);
    }
  }
  return cycles;
}

/**
 * Find forbidden edges, including ones reached through other packages.
 *
 * @param {Map<string, string[]>} graph
 * @param {Record<string, string[]>} [forbidden]
 * @returns {string[][]} Dependency paths from the restricted package
 */
export function findForbiddenPaths(graph, forbidden = FORBIDDEN_DEPENDENCIES) {
  const violations = [];
  for (const [from, targets] of Object.entries(forbidden)) {
    const queue = [[from]];
    const visited = new Set([from]);
    while (queue.length > 0) {
      const path = queue.shift();
      for (const dependency of graph.get(path.at(-1)) ?? []) {
        const next = [...path, dependency];
        if (targets.includes(dependency)) {
          violations.push(next);
        }
        if (!visited.has(dependency)) {
          visited.add(dependency);
          queue.push(next);
        }
      }
    }
  }
  return violations;
}

function readWorkspaceManifests(root) {
  const listed = JSON.parse(
    execFileSync("pnpm", ["list", "--recursive", "--depth", "-1", "--json"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
  return listed
    .filter(({ path }) => resolve(path) !== root)
    .map(({ path }) =>
      JSON.parse(readFileSync(resolve(path, "package.json"), "utf8")),
    );
}

function main() {
  const root = resolve(import.meta.dirname, "..");
  const graph = buildGraph(readWorkspaceManifests(root));
  const errors = [
    ...findCycles(graph).map(
      (cycle) => `Workspace dependency cycle: ${cycle.join(" -> ")}`,
    ),
    ...findForbiddenPaths(graph).map(
      (path) =>
        `Forbidden workspace dependency: ${path.join(" -> ")} (see docs/architecture/overview.md#package-dependency-direction)`,
    ),
  ];
  if (errors.length > 0) {
    process.stderr.write(`${errors.join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Workspace dependency graph OK (${graph.size} packages, no cycles).\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
