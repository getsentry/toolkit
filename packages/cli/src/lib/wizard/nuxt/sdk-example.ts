/**
 * Create the Nuxt example page (with its API route) or the example error
 * button component that the user can trigger to test Sentry.
 */

import { existsSync, mkdirSync, promises } from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { reportCliError } from "../../error-reporting.js";
import { abort, isUsingTypeScript } from "../utils/clack/index.js";
import { clack } from "../utils/clack/prompts.js";
import {
  getIndexRouteTemplate,
  getSentryErrorButtonTemplate,
  getSentryExampleApiTemplate,
  getSentryExamplePageTemplate,
} from "./templates.js";

function getSrcDirectory(isNuxtV4: boolean): string {
  // In nuxt v4, the src directory is `app/` unless
  // users already had a `pages` directory
  return isNuxtV4 && !existsSync(path.resolve("pages")) ? "app" : ".";
}

/** Whether the app renders pages, so an example page would be reachable. */
export async function supportsExamplePage(isNuxtV4: boolean): Promise<boolean> {
  // We currently only support creating an example page
  // if users can reliably access it without having to
  // add code changes themselves.
  //
  // If users have an `app.vue` layout without the
  // needed component to render routes (<NuxtPage/>),
  // we bail out of creating an example page altogether.
  const src = getSrcDirectory(isNuxtV4);
  const app = path.join(src, "app.vue");

  // If there's no `app.vue` layout, nuxt automatically renders
  // the routes.
  if (!existsSync(path.resolve(app))) {
    return true;
  }

  const content = await promises.readFile(path.resolve(app), "utf8");
  return !!content.match(/<NuxtPage/g);
}

/** Write the example page and its API route. */
export async function createExamplePage(
  isNuxtV4: boolean,
  options: {
    org: string;
    project: string;
    projectId: string;
    url: string;
  },
): Promise<void> {
  try {
    const src = getSrcDirectory(isNuxtV4);
    const pages = path.join(src, "pages");

    if (!existsSync(path.resolve(pages))) {
      mkdirSync(path.resolve(pages), { recursive: true });

      const indexPage = path.join(pages, "index.vue");

      await promises.writeFile(
        path.resolve(indexPage),
        getIndexRouteTemplate(),
      );

      clack.log.success(`Created ${chalk.cyan(indexPage)}.`);
    }

    const examplePage = path.join(pages, "sentry-example-page.vue");

    if (existsSync(path.resolve(examplePage))) {
      clack.log.warn(
        `It seems like a sentry example page already exists. Skipping creation of example page.`,
      );
      return;
    }

    await promises.writeFile(
      path.resolve(examplePage),
      getSentryExamplePageTemplate(options),
    );

    clack.log.success(`Created ${chalk.cyan(examplePage)}.`);

    const api = path.join("server", "api");

    if (!existsSync(path.resolve(api))) {
      mkdirSync(path.resolve(api), { recursive: true });
    }

    const exampleApi = path.join(
      api,
      isUsingTypeScript() ? "sentry-example-api.ts" : "sentry-example-api.js",
    );

    await promises.writeFile(
      path.resolve(exampleApi),
      getSentryExampleApiTemplate(),
    );

    clack.log.success(`Created ${chalk.cyan(exampleApi)}.`);
  } catch (e: unknown) {
    clack.log.error("Error while creating an example page to test Sentry:");
    clack.log.info(
      chalk.dim(
        e instanceof Error
          ? e.toString()
          : typeof e === "string"
            ? e
            : "Unknown error",
      ),
    );
    reportCliError(e);
    await abort("Exiting Wizard");
  }
}

/** Write the `SentryErrorButton` example component. */
export async function createExampleComponent(isNuxtV4: boolean): Promise<void> {
  const src = getSrcDirectory(isNuxtV4);
  const components = path.join(src, "components");

  if (!existsSync(path.resolve(components))) {
    mkdirSync(path.resolve(components), { recursive: true });
  }

  const exampleComponent = path.join(components, "SentryErrorButton.vue");

  await promises.writeFile(
    path.resolve(exampleComponent),
    getSentryErrorButtonTemplate(),
  );

  clack.log.success(`Created ${chalk.cyan(exampleComponent)}.`);
}
