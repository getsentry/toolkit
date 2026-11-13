/**
 * Verify every command declares an exposure and that its permission class
 * agrees with the requests it sends (`script/lib/command-access.ts`). Uses the
 * same source analysis as `generate:command-api`.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Command, RouteMap } from "../src/lib/introspect.js";
import {
  allCommands,
  type CommandRequests,
  commandAccessProblems,
} from "./lib/command-access.js";
import { analyzeCliSources } from "./lib/source-api-usage.js";
import { logger } from "../src/lib/logger.js";

const { analysis } = await analyzeCliSources();

// A command re-exported under another name has one entry per export.
const requests = new Map<Command, CommandRequests>();
for (const { file, name } of analysis.commands) {
  const usage = analysis.exports.get(file)?.get(name);
  const module = await import(pathToFileURL(resolve(file)).href);
  const command = module[name] as Command | undefined;
  if (!(usage && command)) continue;
  const previous = requests.get(command);
  requests.set(command, {
    methods: [...(previous?.methods ?? []), ...usage.methods],
    apiMethods: [...(previous?.apiMethods ?? []), ...usage.apiMethods],
  });
}

const { routes } = await import("../src/app.js");
const commands = allCommands(routes as unknown as RouteMap);
const problems = [...commands].flatMap(([command, path]) =>
  commandAccessProblems(command, requests.get(command)).map(
    (problem) => `${path} ${problem}`,
  ),
);

if (problems.length === 0) {
  logger.success(
    `All ${commands.size} commands declare an exposure and a permission class that matches their requests`,
  );
} else {
  logger.error(
    [
      `${problems.length} command access problem(s):\n`,
      ...problems.map((problem) => `  ${problem}`),
      "\n  See script/lib/command-access.ts for when a command declares `permission`.",
    ].join("\n"),
  );
  process.exitCode = 1;
}
