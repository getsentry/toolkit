#!/usr/bin/env tsx
/** Generate command/API relationships from source calls and the public route tree. */

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { glob } from "tinyglobby";
import type { ApiEndpoint, ApiReference } from "../src/lib/api-schema.js";
import type { RouteMap, RouteTarget } from "../src/lib/introspect.js";
import { analyzeSourceApiUsage } from "./lib/source-api-usage.js";

const OUTPUT_PATH = "src/generated/command-api.json";

// The route tree imports these generated files. Bootstrap before importing it;
// generate:skill replaces its stub later in the same generate:docs pipeline.
await mkdir("src/generated", { recursive: true });
for (const [path, stub] of [
  [OUTPUT_PATH, "{}\n"],
  [
    "src/generated/skill-content.ts",
    "export const SKILL_FILES: [string, string][] = [];\n",
  ],
] as const) {
  if (
    !(await access(path).then(
      () => true,
      () => false,
    ))
  ) {
    await writeFile(path, stub);
  }
}

const files = await glob(["src/**/*.{ts,tsx}"], {
  ignore: ["src/generated/**"],
});
const sources = new Map(
  await Promise.all(
    files
      .sort()
      .map(async (file) => [file, await readFile(file, "utf8")] as const),
  ),
);
const endpoints = JSON.parse(
  await readFile("src/generated/api-schema.json", "utf8"),
) as ApiEndpoint[];
const analysis = analyzeSourceApiUsage(
  sources,
  endpoints
    .filter((entry) => entry.fn)
    .map((entry) => ({
      functionName: entry.fn,
      method: entry.method,
      path: entry.path,
    })),
);

const { routes } = await import("../src/app.js");
const { isCommand, publicTargetPaths } =
  await import("../src/lib/introspect.js");
const paths = publicTargetPaths(routes as unknown as RouteMap);
const matched = new Set<RouteTarget>();
const references: Record<string, ApiReference[]> = {};
const unresolved = new Map<string, { commands: Set<string>; reason: string }>();

for (const { file, name } of analysis.commands) {
  const module = await import(pathToFileURL(resolve(file)).href);
  const target = module[name] as RouteTarget | undefined;
  const path = target && paths.get(target);
  if (!target || !path || !isCommand(target)) continue;
  matched.add(target);
  const command = `sentry ${path.join(" ")}`;
  const usage = analysis.exports.get(file)?.get(name);
  if (!usage) continue;
  const entries = (references[command] ??= []);
  for (const operation of usage.operations) {
    const context = Object.entries(operation.query ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join(", ");
    const reference: ApiReference = {
      fn: operation.functionName,
      ...(context
        ? {
            note: `Known query context: ${context}. The command may add filters or requests.`,
          }
        : {}),
    };
    if (
      !entries.some(
        (entry) => entry.fn === reference.fn && entry.note === reference.note,
      )
    )
      entries.push(reference);
  }
  for (const request of usage.unresolvedRequests) {
    const key = `${request.file}:${request.line}`;
    const diagnostic = unresolved.get(key) ?? {
      commands: new Set<string>(),
      reason: request.reason,
    };
    diagnostic.commands.add(command);
    unresolved.set(key, diagnostic);
  }
}

for (const [target, path] of paths) {
  if (isCommand(target) && !matched.has(target)) {
    console.warn(
      `API discovery: no source command export found for sentry ${path.join(" ")}`,
    );
  }
}
for (const [location, { commands, reason }] of unresolved) {
  console.warn(
    `API discovery: ${location}: ${reason} (${[...commands].sort().join(", ")})`,
  );
}

const catalog = Object.fromEntries(
  Object.entries(references)
    .filter(([, entries]) => entries.length)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([command, entries]) => [
      command,
      entries.sort(
        (a, b) =>
          a.fn.localeCompare(b.fn) ||
          (a.note ?? "").localeCompare(b.note ?? ""),
      ),
    ]),
);
await writeFile(OUTPUT_PATH, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(
  `Generated ${OUTPUT_PATH} (${Object.keys(catalog).length} commands; ${unresolved.size} unresolved requests)`,
);
