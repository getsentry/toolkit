/**
 * Generate command/API relationships from source calls and the public route
 * tree, and the class of each command's Sentry API requests
 * (`lib/command-access.ts`).
 */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { routes } from "../src/app.js";
import type { ApiReference } from "../src/lib/api-schema.js";
import { type ApiAccess, apiAccess } from "../src/lib/command-access.js";
import {
  isCommand,
  publicTargetPaths,
  type RouteMap,
  type RouteTarget,
} from "../src/lib/introspect.js";
import { commandApiAnalysis } from "./lib/command-api-analysis.js";

const OUTPUT_PATH = "src/generated/command-api.json";
const ACCESS_OUTPUT_PATH = "src/generated/command-api-access.json";

/** Write which API operations each public command calls. */
export async function emit(): Promise<void> {
  const analysis = await commandApiAnalysis();

  const paths = publicTargetPaths(routes as unknown as RouteMap);
  const matched = new Set<RouteTarget>();
  const references: Record<string, ApiReference[]> = {};
  const unresolved = new Map<
    string,
    { commands: Set<string>; reason: string }
  >();
  const apiMethods = new Map<string, (string | undefined)[]>();

  for (const { file, name } of analysis.commands) {
    const module = await import(pathToFileURL(resolve(file)).href);
    const target = module[name] as RouteTarget | undefined;
    const path = target && paths.get(target);
    if (!target || !path || !isCommand(target)) continue;
    matched.add(target);
    const command = `sentry ${path.join(" ")}`;
    const usage = analysis.exports.get(file)?.get(name);
    if (!usage) continue;
    apiMethods.set(command, [
      ...(apiMethods.get(command) ?? []),
      ...usage.apiMethods,
    ]);
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
  const apiAccessByCommand: Record<string, ApiAccess> = {};
  for (const [command, methods] of [...apiMethods].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const value = apiAccess(methods);
    if (value) apiAccessByCommand[command] = value;
  }
  await writeFile(
    ACCESS_OUTPUT_PATH,
    `${JSON.stringify(apiAccessByCommand, null, 2)}\n`,
  );
  console.log(
    `Generated ${OUTPUT_PATH} (${Object.keys(catalog).length} commands; ${unresolved.size} unresolved requests)`,
  );
}
