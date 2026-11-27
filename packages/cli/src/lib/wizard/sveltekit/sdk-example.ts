/**
 * Writes the example page and API route that throw a test error in a
 * SvelteKit app.
 */

import { existsSync, mkdirSync, promises } from "node:fs";
import path from "node:path";
import { clack } from "../utils/clack/prompts.js";

import type { PartialBackwardsForwardsCompatibleSvelteConfig } from "./sdk-setup/svelte-config.js";
import {
  getSentryExampleApiRoute,
  getSentryExampleSveltePage,
} from "./templates.js";

/**
 * Creates example page and API route to test Sentry
 */
export async function createExamplePage(
  svelteConfig: PartialBackwardsForwardsCompatibleSvelteConfig,
  projectProps: {
    selfHosted: boolean;
    url: string;
    orgSlug: string;
    projectId: string;
    isUsingSvelte5: boolean;
  },
): Promise<void> {
  const routesDirectory = svelteConfig.kit?.files?.routes || "src/routes";
  const exampleRoutePath = path.resolve(
    path.join(routesDirectory, "sentry-example-page"),
  );

  if (!existsSync(routesDirectory)) {
    clack.log.warn(
      `Couldn't find your routes directory. Creating it now: ${routesDirectory}`,
    );
    mkdirSync(routesDirectory, { recursive: true });
  }

  if (!existsSync(exampleRoutePath)) {
    mkdirSync(exampleRoutePath);
  } else {
    clack.log.warn(
      `It seems like a sentry example page already exists (${path.basename(
        exampleRoutePath,
      )}). Skipping creation of example route.`,
    );
    return;
  }

  await promises.writeFile(
    path.join(exampleRoutePath, "+page.svelte"),
    getSentryExampleSveltePage({
      ...projectProps,
    }),
  );

  await promises.writeFile(
    path.join(exampleRoutePath, "+server.js"),
    getSentryExampleApiRoute(),
  );
}
