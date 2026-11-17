/**
 * The application the SDK (`lib/sdk-invoke.ts`) runs commands in.
 *
 * Like the CLI (`app-for-args.ts`), it loads only the top-level routes a call
 * runs, so an app that uses the SDK loads only the commands it calls. Calls
 * can run at the same time, so the routes the SDK registers only grow: it
 * registers every route loaded so far. A call that needs the whole command
 * tree (`help`, `schema`, `cli`, or an unknown name) loads `app.ts`, which
 * the SDK uses from then on.
 */

import { loadRoute, routesForArgs } from "./app-for-args.js";
import {
  buildSentryApp,
  buildSentryRoutes,
  type SentryRoutes,
} from "./app-root.js";
import type { CliApplication } from "./lib/application.js";
import type { CliRoutes } from "./lib/route-registry.js";

type SdkApp = { app: CliApplication; routes: CliRoutes };

/** The top-level routes loaded so far, by name. */
const loaded: Record<string, SentryRoutes[string]> = {};

/**
 * The application over {@link loaded}, and how many routes it has. A call
 * rebuilds it when another call added a route since.
 */
let partialApp: { app: SdkApp; size: number } | undefined;

/** The full application, once a call needed it. */
let fullApp: Promise<SdkApp> | undefined;

/** Load the application that runs `args` (`["issue", "list", ...]`). */
export async function loadSdkApp(args: readonly string[]): Promise<SdkApp> {
  const names = fullApp ? undefined : routesForArgs(args);
  if (!names) {
    fullApp ??= import("./app.js");
    return await fullApp;
  }
  const missing = names.filter((name) => !Object.hasOwn(loaded, name));
  // At most three imports (`help`, the route, its singular), so no limit is
  // needed. Calls that load the same route at once share the module, which
  // `import()` evaluates once.
  await Promise.all(
    missing.map(async (name) => {
      loaded[name] = await loadRoute(name);
    }),
  );
  // Another call may have registered the full tree in the meantime
  if (fullApp) {
    return await fullApp;
  }
  const size = Object.keys(loaded).length;
  if (partialApp?.size !== size) {
    const routes = buildSentryRoutes({ ...loaded });
    partialApp = { app: { app: buildSentryApp(routes), routes }, size };
  }
  return partialApp.app;
}
