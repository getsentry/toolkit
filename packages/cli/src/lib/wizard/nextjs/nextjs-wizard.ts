/**
 * The Next.js setup wizard: installs `@sentry/nextjs`, wraps the Next.js
 * config with `withSentryConfig`, and writes the SDK init files, an example
 * page, and the auth token for source map uploads.
 */

import { clack } from "../utils/clack/prompts.js";
import chalk from "chalk";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  promises,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { parseModule } from "magicast";
import path from "node:path";

import { Sentry } from "../telemetry.js";

import { setupCI } from "../sourcemaps/ci.js";
import { traceStep, withTelemetry } from "../telemetry.js";
import {
  abort,
  abortIfCancelled,
  addDotEnvSentryBuildPluginFile,
  askShouldCreateExamplePage,
  confirmContinueIfNoOrDirtyGitRepo,
  createNewConfigFile,
  ensurePackageIsInstalled,
  featureSelectionPrompt,
  getOrAskForProjectData,
  getPackageDotJson,
  getPackageManager,
  installPackage,
  printSdkV11MigrationGuideIfOutdated,
  isUsingTypeScript,
  printWelcome,
  runFormatters,
  showCopyPasteInstructions,
} from "../utils/clack/index.js";
import {
  getPackageVersion,
  hasPackageInstalled,
} from "../utils/package-json.js";
import type { SentryProjectData, WizardOptions } from "../utils/types.js";
import { offerProjectScopedMcpConfig } from "../utils/clack/mcp-config.js";
import {
  getFullUnderscoreErrorCopyPasteSnippet,
  getGlobalErrorCopyPasteSnippet,
  getInstrumentationHookContent,
  getInstrumentationHookCopyPasteSnippet,
  getNextjsConfigCjsAppendix,
  getNextjsConfigCjsTemplate,
  getNextjsConfigEsmCopyPasteSnippet,
  getNextjsConfigMjsTemplate,
  getRootLayout,
  getSentryServersideConfigContents,
  getInstrumentationClientFileContents,
  getSentryDefaultGlobalErrorPage,
  getSentryDefaultUnderscoreErrorPage,
  getSentryExampleAppDirApiRoute,
  getSentryExamplePageContents,
  getSentryExamplePagesDirApiRoute,
  getSimpleUnderscoreErrorCopyPasteSnippet,
  getWithSentryConfigOptionsTemplate,
  getInstrumentationClientHookCopyPasteSnippet,
  getRootLayoutWithGenerateMetadata,
  getGenerateMetadataSnippet,
} from "./templates.js";
import {
  getMaybeAppDirLocation,
  getNextJsVersionBucket,
  hasRootLayoutFile,
  unwrapSentryConfigAst,
  wrapWithSentryConfig,
  addWithSentryConfigImport,
  isNextJsVersionSupported,
  MIN_SUPPORTED_NEXTJS_MAJOR,
  MIN_SDK_VERSION_WITH_CONFIG_SUBPATH,
  getExampleApiRouteDynamicStrategy,
  getWithSentryConfigImportPath,
} from "./utils.js";
import { SENTRY_NEXTJS_ROOT_IMPORT_PATH } from "./templates.js";
import { warnIfNodeVersionUnsupportedBySdkV11 } from "../utils/node-version.js";
import {
  askShouldReduceDataCollection,
  sdkSupportsDataCollection,
} from "../utils/data-collection.js";
import { debug } from "../utils/debug.js";

export function runNextjsWizard(options: WizardOptions) {
  return withTelemetry(
    {
      enabled: options.telemetryEnabled,
      integration: "nextjs",
      wizardOptions: options,
    },
    () => runNextjsWizardWithTelemetry(options),
  );
}

export async function runNextjsWizardWithTelemetry(
  options: WizardOptions,
): Promise<void> {
  const { telemetryEnabled, forceInstall } = options;

  printWelcome({
    wizardName: "Sentry Next.js Wizard",
    telemetryEnabled,
  });

  const typeScriptDetected = isUsingTypeScript();

  warnIfNodeVersionUnsupportedBySdkV11();

  await confirmContinueIfNoOrDirtyGitRepo({
    ignoreGitChanges: options.ignoreGitChanges,
    cwd: undefined,
  });

  const packageJson = await getPackageDotJson();

  await ensurePackageIsInstalled(packageJson, "next", "Next.js");

  const nextVersion = getPackageVersion("next", packageJson);
  Sentry.setTag("nextjs-version", getNextJsVersionBucket(nextVersion));

  if (!isNextJsVersionSupported(nextVersion)) {
    clack.log.warn(
      `${chalk.yellow(
        `Version 11 of the Sentry Next.js SDK requires Next.js ${MIN_SUPPORTED_NEXTJS_MAJOR} or newer, but this project uses ${chalk.bold(
          `next@${nextVersion ?? "unknown"}`,
        )}.`,
      )}
The wizard will continue, but you may need to upgrade Next.js for the SDK to work.`,
    );
  }

  const projectData = await getOrAskForProjectData(
    options,
    "javascript-nextjs",
  );

  const sdkAlreadyInstalled = hasPackageInstalled(
    "@sentry/nextjs",
    packageJson,
  );
  Sentry.setTag("sdk-already-installed", sdkAlreadyInstalled);

  printSdkV11MigrationGuideIfOutdated("@sentry/nextjs", packageJson);

  const { packageManager: packageManagerFromInstallStep } =
    await installPackage({
      packageName: "@sentry/nextjs@^11",
      packageNameDisplayLabel: "@sentry/nextjs",
      alreadyInstalled: sdkAlreadyInstalled,
      forceInstall,
    });

  // `installPackage` may have skipped the install if the user declined the
  // update prompt, so re-read package.json to learn which SDK is actually there.
  const installedSdkVersion = getPackageVersion(
    "@sentry/nextjs",
    await getPackageDotJson(),
  );
  const withSentryConfigImportPath =
    getWithSentryConfigImportPath(installedSdkVersion);
  if (withSentryConfigImportPath === SENTRY_NEXTJS_ROOT_IMPORT_PATH) {
    clack.log.warn(
      `${chalk.yellow(
        `Your project uses ${chalk.bold(
          `@sentry/nextjs@${installedSdkVersion ?? "unknown"}`,
        )}, which predates ${MIN_SDK_VERSION_WITH_CONFIG_SUBPATH}.`,
      )}
The wizard will import ${chalk.cyan(
        "withSentryConfig",
      )} from the root package for now. Once you upgrade the SDK (required for v11), change the import in your Next.js config to ${chalk.cyan(
        "@sentry/nextjs/config",
      )}.`,
    );
  }

  // From v11 on, the SDK collects rich context by default, so offer to
  // reduce collection of data that can identify users.
  const reduceDataCollection =
    // An unknown version (e.g. `workspace:*`) is the `^11` the wizard asked for.
    sdkSupportsDataCollection(installedSdkVersion, "^11") &&
    (await askShouldReduceDataCollection());

  let selectedProject: SentryProjectData;
  let authToken: string;
  let selfHosted: boolean;
  let sentryUrl: string;
  let spotlight: boolean;

  if (projectData.spotlight) {
    // Spotlight mode: use empty DSN and skip auth
    spotlight = true;
    selfHosted = false;
    sentryUrl = "";
    authToken = "";
    // Create a minimal project structure for type compatibility
    selectedProject = {
      id: "",
      slug: "",
      organization: { id: "", slug: "", name: "" },
      keys: [{ dsn: { public: "" } }],
    };
  } else {
    spotlight = false;
    ({ selectedProject, authToken, selfHosted, sentryUrl } = projectData);
  }

  await traceStep("configure-sdk", async () => {
    const tunnelRoute = await askShouldSetTunnelRoute();

    return await createOrMergeNextJsFiles(
      selectedProject,
      selfHosted,
      sentryUrl,
      {
        tunnelRoute,
        withSentryConfigImportPath,
        reduceDataCollection,
        spotlight,
      },
    );
  });

  await traceStep("create-underscoreerror-page", async () => {
    const srcDir = path.join(process.cwd(), "src");
    const maybePagesDirPath = path.join(process.cwd(), "pages");
    const maybeSrcPagesDirPath = path.join(srcDir, "pages");

    const pagesLocation =
      existsSync(maybePagesDirPath) &&
      lstatSync(maybePagesDirPath).isDirectory()
        ? ["pages"]
        : existsSync(maybeSrcPagesDirPath) &&
            lstatSync(maybeSrcPagesDirPath).isDirectory()
          ? ["src", "pages"]
          : undefined;

    if (!pagesLocation) {
      return;
    }

    const underscoreErrorPageFile = existsSync(
      path.join(process.cwd(), ...pagesLocation, "_error.tsx"),
    )
      ? "_error.tsx"
      : existsSync(path.join(process.cwd(), ...pagesLocation, "_error.ts"))
        ? "_error.ts"
        : existsSync(path.join(process.cwd(), ...pagesLocation, "_error.jsx"))
          ? "_error.jsx"
          : existsSync(path.join(process.cwd(), ...pagesLocation, "_error.js"))
            ? "_error.js"
            : undefined;

    if (!underscoreErrorPageFile) {
      const underscoreErrorFileName = `_error.${
        typeScriptDetected ? "tsx" : "jsx"
      }`;

      await promises.writeFile(
        path.join(process.cwd(), ...pagesLocation, underscoreErrorFileName),
        getSentryDefaultUnderscoreErrorPage(),
        { encoding: "utf8", flag: "w" },
      );

      clack.log.success(
        `Created ${chalk.cyan(
          path.join(...pagesLocation, underscoreErrorFileName),
        )}.`,
      );
    } else if (
      readFileSync(
        path.join(process.cwd(), ...pagesLocation, underscoreErrorPageFile),
        "utf8",
      ).includes("getInitialProps")
    ) {
      clack.log.info(
        `It seems like you already have a custom error page.\n\nPlease put the following function call in the ${chalk.bold(
          "getInitialProps",
        )}\nmethod of your custom error page at ${chalk.bold(
          path.join(...pagesLocation, underscoreErrorPageFile),
        )}:`,
      );
      clack.rawOutput(getSimpleUnderscoreErrorCopyPasteSnippet());

      const shouldContinue = await abortIfCancelled(
        clack.confirm({
          message: `Did you modify your ${chalk.cyan(
            path.join(...pagesLocation, underscoreErrorPageFile),
          )} file as described above?`,
          active: "Yes",
          inactive: "No, get me out of here",
        }),
      );

      if (!shouldContinue) {
        await abort();
      }
    } else {
      clack.log.info(
        `It seems like you already have a custom error page.\n\nPlease add the following code to your custom error page\nat ${chalk.cyan(
          path.join(...pagesLocation, underscoreErrorPageFile),
        )}:`,
      );
      clack.rawOutput(
        getFullUnderscoreErrorCopyPasteSnippet(
          underscoreErrorPageFile === "_error.ts" ||
            underscoreErrorPageFile === "_error.tsx",
        ),
      );

      const shouldContinue = await abortIfCancelled(
        clack.confirm({
          message: `Did you add the code to your ${chalk.cyan(
            path.join(...pagesLocation, underscoreErrorPageFile),
          )} file as described above?`,
          active: "Yes",
          inactive: "No, get me out of here",
        }),
      );

      if (!shouldContinue) {
        await abort();
      }
    }
  });

  await traceStep("create-global-error-page", async () => {
    const appDirLocation = getMaybeAppDirLocation();

    if (!appDirLocation) {
      return;
    }

    const globalErrorPageFile = existsSync(
      path.join(process.cwd(), ...appDirLocation, "global-error.tsx"),
    )
      ? "global-error.tsx"
      : existsSync(
            path.join(process.cwd(), ...appDirLocation, "global-error.ts"),
          )
        ? "global-error.ts"
        : existsSync(
              path.join(process.cwd(), ...appDirLocation, "global-error.jsx"),
            )
          ? "global-error.jsx"
          : existsSync(
                path.join(process.cwd(), ...appDirLocation, "global-error.js"),
              )
            ? "global-error.js"
            : undefined;

    if (!globalErrorPageFile) {
      const newGlobalErrorFileName = `global-error.${
        typeScriptDetected ? "tsx" : "jsx"
      }`;

      await promises.writeFile(
        path.join(process.cwd(), ...appDirLocation, newGlobalErrorFileName),
        getSentryDefaultGlobalErrorPage(typeScriptDetected),
        { encoding: "utf8", flag: "w" },
      );

      clack.log.success(
        `Created ${chalk.cyan(
          path.join(...appDirLocation, newGlobalErrorFileName),
        )}.`,
      );
    } else {
      clack.log.info(
        `It seems like you already have a custom error page for your app directory.\n\nPlease add the following code to your custom error page\nat ${chalk.cyan(
          path.join(...appDirLocation, globalErrorPageFile),
        )}:\n`,
      );
      clack.rawOutput(
        getGlobalErrorCopyPasteSnippet(
          globalErrorPageFile === "global-error.ts" ||
            globalErrorPageFile === "global-error.tsx",
        ),
      );

      const shouldContinue = await abortIfCancelled(
        clack.confirm({
          message: `Did you add the code to your ${chalk.cyan(
            path.join(...appDirLocation, globalErrorPageFile),
          )} file as described above?`,
          active: "Yes",
          inactive: "No, get me out of here",
        }),
      );

      if (!shouldContinue) {
        await abort();
      }
    }
  });

  await traceStep("add-generate-metadata-function", async () => {
    const isNext14 = getNextJsVersionBucket(nextVersion) === "14.x";
    const appDirLocation = getMaybeAppDirLocation();

    // We only need this specific change for app router on next@14
    if (!appDirLocation || !isNext14) {
      return;
    }

    const appDirPath = path.join(process.cwd(), ...appDirLocation);
    const hasRootLayout = hasRootLayoutFile(appDirPath);

    if (!hasRootLayout) {
      const newRootLayoutFilename = `layout.${
        typeScriptDetected ? "tsx" : "jsx"
      }`;

      await promises.writeFile(
        path.join(appDirPath, newRootLayoutFilename),
        getRootLayoutWithGenerateMetadata(typeScriptDetected),
        { encoding: "utf8", flag: "w" },
      );

      clack.log.success(
        `Created ${chalk.cyan(
          path.join(...appDirLocation, newRootLayoutFilename),
        )}.`,
      );
    } else {
      clack.log.info(
        `It seems like you already have a root layout component. Please add or modify your generateMetadata function.`,
      );

      await showCopyPasteInstructions({
        filename: `layout.${typeScriptDetected ? "tsx" : "jsx"}`,
        codeSnippet: getGenerateMetadataSnippet(typeScriptDetected),
      });
    }
  });

  const shouldCreateExamplePage = await askShouldCreateExamplePage();
  if (shouldCreateExamplePage) {
    await traceStep(
      "create-example-page",
      async () =>
        await createExamplePage(
          selfHosted,
          selectedProject,
          sentryUrl,
          typeScriptDetected,
          nextVersion,
        ),
    );
  }

  if (!spotlight) {
    await addDotEnvSentryBuildPluginFile(authToken);
  }

  const isLikelyUsingTurbopack = await checkIfLikelyIsUsingTurbopack();
  if (isLikelyUsingTurbopack || isLikelyUsingTurbopack === null) {
    await abortIfCancelled(
      clack.select({
        message:
          "Warning: The Sentry SDK is only compatible with Turbopack on Next.js version 15.4.1 or later.",
        options: [
          {
            label: "I understand.",
            hint: "press enter",
            value: true,
          },
        ],
        initialValue: true,
      }),
    );
  }

  const mightBeUsingVercel = existsSync(
    path.join(process.cwd(), "vercel.json"),
  );

  if (mightBeUsingVercel) {
    clack.log.info(
      "▲ It seems like you're using Vercel. We recommend using the Sentry Vercel \
      integration to set up an auth token for Vercel deployments: https://vercel.com/integrations/sentry",
    );
  } else if (!spotlight) {
    await setupCI("nextjs", authToken);
  }

  const packageManagerForOutro =
    packageManagerFromInstallStep ?? (await getPackageManager());

  // Offer optional project-scoped MCP config for Sentry with org and project scope
  await offerProjectScopedMcpConfig(
    selectedProject.organization.slug,
    selectedProject.slug,
  );

  // Run formatters as the last step to fix any formatting issues in generated/modified files
  await runFormatters({ cwd: undefined });

  clack.outro(`
${chalk.green("Successfully installed the Sentry Next.js SDK!")} ${
    shouldCreateExamplePage
      ? `\n\nYou can validate your setup by (re)starting your dev environment (e.g. ${chalk.cyan(
          `${packageManagerForOutro.runScriptCommand} dev`,
        )}) and visiting ${chalk.cyan('"/sentry-example-page"')}`
      : ""
  }

${chalk.dim(
  "If you encounter any issues, let us know here: https://github.com/getsentry/sentry-javascript/issues",
)}`);
}

type SDKConfigOptions = {
  tunnelRoute: boolean;
  /** Module `withSentryConfig` is imported from; depends on the installed SDK version. */
  withSentryConfigImportPath: string;
  /** Write the reduced-PII `dataCollection` option into `Sentry.init()`. */
  reduceDataCollection: boolean;
  /** Set up Spotlight only, without a Sentry project. */
  spotlight: boolean;
};

async function createOrMergeNextJsFiles(
  selectedProject: SentryProjectData,
  selfHosted: boolean,
  sentryUrl: string,
  sdkConfigOptions: SDKConfigOptions,
): Promise<void> {
  const { reduceDataCollection, spotlight } = sdkConfigOptions;
  const dsn = selectedProject.keys[0].dsn.public;
  const selectedFeatures = await featureSelectionPrompt([
    {
      id: "performance",
      prompt: `Do you want to enable ${chalk.bold(
        "Tracing",
      )} to track the performance of your application?`,
      enabledHint: "recommended",
    },
    {
      id: "replay",
      prompt: `Do you want to enable ${chalk.bold(
        "Session Replay",
      )} to get a video-like reproduction of errors during a user session?`,
      enabledHint: "recommended, but increases bundle size",
    },
  ] as const);

  const typeScriptDetected = isUsingTypeScript();

  const configVariants = ["server", "edge"] as const;

  for (const configVariant of configVariants) {
    await traceStep(`create-sentry-${configVariant}-config`, async () => {
      const jsConfig = `sentry.${configVariant}.config.js`;
      const tsConfig = `sentry.${configVariant}.config.ts`;

      const jsConfigExists = existsSync(path.join(process.cwd(), jsConfig));
      const tsConfigExists = existsSync(path.join(process.cwd(), tsConfig));

      let shouldWriteFile = true;

      if (jsConfigExists || tsConfigExists) {
        const existingConfigs = [];

        if (jsConfigExists) {
          existingConfigs.push(jsConfig);
        }

        if (tsConfigExists) {
          existingConfigs.push(tsConfig);
        }

        const overwriteExistingConfigs = await abortIfCancelled(
          clack.confirm({
            message: `Found existing Sentry ${configVariant} config (${existingConfigs.join(
              ", ",
            )}). Overwrite ${existingConfigs.length > 1 ? "them" : "it"}?`,
          }),
        );
        Sentry.setTag(
          `overwrite-${configVariant}-config`,
          overwriteExistingConfigs,
        );

        shouldWriteFile = overwriteExistingConfigs;

        if (overwriteExistingConfigs) {
          if (jsConfigExists) {
            unlinkSync(path.join(process.cwd(), jsConfig));
            clack.log.warn(`Removed existing ${chalk.cyan(jsConfig)}.`);
          }
          if (tsConfigExists) {
            unlinkSync(path.join(process.cwd(), tsConfig));
            clack.log.warn(`Removed existing ${chalk.cyan(tsConfig)}.`);
          }
        }
      }

      if (shouldWriteFile) {
        await promises.writeFile(
          path.join(process.cwd(), typeScriptDetected ? tsConfig : jsConfig),
          getSentryServersideConfigContents(
            dsn,
            configVariant,
            selectedFeatures,
            reduceDataCollection,
            spotlight,
          ),
          { encoding: "utf8", flag: "w" },
        );
        clack.log.success(
          `Created fresh ${chalk.cyan(
            typeScriptDetected ? tsConfig : jsConfig,
          )}.`,
        );
        Sentry.setTag(`created-${configVariant}-config`, true);
      }
    });
  }

  await traceStep("setup-instrumentation-hook", async () => {
    const hasRootAppDirectory = hasDirectoryPathFromRoot("app");
    const hasRootPagesDirectory = hasDirectoryPathFromRoot("pages");
    const hasSrcDirectory = hasDirectoryPathFromRoot("src");

    let instrumentationHookLocation: "src" | "root" | "does-not-exist";

    const instrumentationTsExists = existsSync(
      path.join(process.cwd(), "instrumentation.ts"),
    );
    const instrumentationJsExists = existsSync(
      path.join(process.cwd(), "instrumentation.js"),
    );
    const srcInstrumentationTsExists = existsSync(
      path.join(process.cwd(), "src", "instrumentation.ts"),
    );
    const srcInstrumentationJsExists = existsSync(
      path.join(process.cwd(), "src", "instrumentation.js"),
    );

    // https://nextjs.org/docs/app/building-your-application/configuring/src-directory
    // https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
    // The logic for where Next.js picks up the instrumentation file is as follows:
    // - If there is either an `app` folder or a `pages` folder in the root directory of your Next.js app, Next.js looks
    // for an `instrumentation.ts` file in the root of the Next.js app.
    // - Otherwise, if there is neither an `app` folder or a `pages` folder in the rood directory of your Next.js app,
    // AND if there is an `src` folder, Next.js will look for the `instrumentation.ts` file in the `src` folder.
    if (hasRootPagesDirectory || hasRootAppDirectory) {
      if (instrumentationJsExists || instrumentationTsExists) {
        instrumentationHookLocation = "root";
      } else {
        instrumentationHookLocation = "does-not-exist";
      }
    } else {
      if (srcInstrumentationTsExists || srcInstrumentationJsExists) {
        instrumentationHookLocation = "src";
      } else {
        instrumentationHookLocation = "does-not-exist";
      }
    }

    const newInstrumentationFileName = `instrumentation.${
      typeScriptDetected ? "ts" : "js"
    }`;

    if (instrumentationHookLocation === "does-not-exist") {
      let newInstrumentationHookLocation: "root" | "src";
      if (hasRootPagesDirectory || hasRootAppDirectory) {
        newInstrumentationHookLocation = "root";
      } else if (hasSrcDirectory) {
        newInstrumentationHookLocation = "src";
      } else {
        newInstrumentationHookLocation = "root";
      }

      const newInstrumentationHookPath =
        newInstrumentationHookLocation === "root"
          ? path.join(process.cwd(), newInstrumentationFileName)
          : path.join(process.cwd(), "src", newInstrumentationFileName);

      const successfullyCreated = await createNewConfigFile(
        newInstrumentationHookPath,
        getInstrumentationHookContent(newInstrumentationHookLocation),
      );

      if (!successfullyCreated) {
        await showCopyPasteInstructions({
          filename: newInstrumentationFileName,
          codeSnippet: getInstrumentationHookCopyPasteSnippet(
            newInstrumentationHookLocation,
          ),
          hint: "create the file if it doesn't already exist",
        });
      }
    } else {
      await showCopyPasteInstructions({
        filename:
          srcInstrumentationTsExists || instrumentationTsExists
            ? "instrumentation.ts"
            : srcInstrumentationJsExists || instrumentationJsExists
              ? "instrumentation.js"
              : newInstrumentationFileName,
        codeSnippet: getInstrumentationHookCopyPasteSnippet(
          instrumentationHookLocation,
        ),
      });
    }
  });

  await traceStep("setup-instrumentation-client-hook", async () => {
    const hasRootAppDirectory = hasDirectoryPathFromRoot("app");
    const hasRootPagesDirectory = hasDirectoryPathFromRoot("pages");
    const hasSrcDirectory = hasDirectoryPathFromRoot("src");

    let instrumentationClientHookLocation: "src" | "root" | "does-not-exist";

    const instrumentationClientTsExists = existsSync(
      path.join(process.cwd(), "instrumentation-client.ts"),
    );
    const instrumentationClientJsExists = existsSync(
      path.join(process.cwd(), "instrumentation-client.js"),
    );
    const srcInstrumentationClientTsExists = existsSync(
      path.join(process.cwd(), "src", "instrumentation-client.ts"),
    );
    const srcInstrumentationClientJsExists = existsSync(
      path.join(process.cwd(), "src", "instrumentation-client.js"),
    );

    // https://nextjs.org/docs/app/building-your-application/configuring/src-directory
    // https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
    // The logic for where Next.js picks up the instrumentation file is as follows:
    // - If there is either an `app` folder or a `pages` folder in the root directory of your Next.js app, Next.js looks
    // for an `instrumentation.ts` file in the root of the Next.js app.
    // - Otherwise, if there is neither an `app` folder or a `pages` folder in the rood directory of your Next.js app,
    // AND if there is an `src` folder, Next.js will look for the `instrumentation.ts` file in the `src` folder.
    if (hasRootPagesDirectory || hasRootAppDirectory) {
      if (instrumentationClientJsExists || instrumentationClientTsExists) {
        instrumentationClientHookLocation = "root";
      } else {
        instrumentationClientHookLocation = "does-not-exist";
      }
    } else {
      if (
        srcInstrumentationClientTsExists ||
        srcInstrumentationClientJsExists
      ) {
        instrumentationClientHookLocation = "src";
      } else {
        instrumentationClientHookLocation = "does-not-exist";
      }
    }

    const newInstrumentationClientFileName = `instrumentation-client.${
      typeScriptDetected ? "ts" : "js"
    }`;

    if (instrumentationClientHookLocation === "does-not-exist") {
      let newInstrumentationClientHookLocation: "root" | "src";
      if (hasRootPagesDirectory || hasRootAppDirectory) {
        newInstrumentationClientHookLocation = "root";
      } else if (hasSrcDirectory) {
        newInstrumentationClientHookLocation = "src";
      } else {
        newInstrumentationClientHookLocation = "root";
      }

      const newInstrumentationClientHookPath =
        newInstrumentationClientHookLocation === "root"
          ? path.join(process.cwd(), newInstrumentationClientFileName)
          : path.join(process.cwd(), "src", newInstrumentationClientFileName);

      const successfullyCreated = await createNewConfigFile(
        newInstrumentationClientHookPath,
        getInstrumentationClientFileContents(
          dsn,
          selectedFeatures,
          reduceDataCollection,
          spotlight,
        ),
      );

      if (!successfullyCreated) {
        await showCopyPasteInstructions({
          filename: newInstrumentationClientFileName,
          codeSnippet: getInstrumentationClientHookCopyPasteSnippet(
            dsn,
            selectedFeatures,
            reduceDataCollection,
            spotlight,
          ),
          hint: "create the file if it doesn't already exist",
        });
      }
    } else {
      await showCopyPasteInstructions({
        filename:
          srcInstrumentationClientTsExists || instrumentationClientTsExists
            ? "instrumentation-client.ts"
            : srcInstrumentationClientJsExists || instrumentationClientJsExists
              ? "instrumentation-client.js"
              : newInstrumentationClientFileName,
        codeSnippet: getInstrumentationClientHookCopyPasteSnippet(
          dsn,
          selectedFeatures,
          reduceDataCollection,
          spotlight,
        ),
      });
    }
  });

  await traceStep("setup-next-config", async () => {
    const withSentryConfigOptionsTemplate = getWithSentryConfigOptionsTemplate({
      orgSlug: selectedProject.organization.slug,
      projectSlug: selectedProject.slug,
      selfHosted,
      sentryUrl,
      tunnelRoute: sdkConfigOptions.tunnelRoute,
    });

    const nextConfigPossibleFilesMap = {
      js: "next.config.js",
      mjs: "next.config.mjs",
      cjs: "next.config.cjs",
      ts: "next.config.ts",
      mts: "next.config.mts",
      cts: "next.config.cts",
    };

    const foundNextConfigFile = Object.entries(nextConfigPossibleFilesMap).find(
      ([, fileName]) => existsSync(path.join(process.cwd(), fileName)),
    );

    if (!foundNextConfigFile) {
      Sentry.setTag("next-config-strategy", "create");

      // Try to figure out whether the user prefers ESM
      let isTypeModule = false;
      try {
        const packageJsonText = await promises.readFile(
          path.join(process.cwd(), "package.json"),
          "utf8",
        );
        const packageJson = JSON.parse(packageJsonText);
        if (packageJson.type === "module") {
          isTypeModule = true;
        }
      } catch (error) {
        debug(error);
        // noop
      }

      // We are creating `next.config.(m)js` files by default as they are supported by the most Next.js versions
      const configFilename = isTypeModule
        ? nextConfigPossibleFilesMap.mjs
        : nextConfigPossibleFilesMap.js;
      const configContent = isTypeModule
        ? getNextjsConfigMjsTemplate(
            withSentryConfigOptionsTemplate,
            sdkConfigOptions.withSentryConfigImportPath,
          )
        : getNextjsConfigCjsTemplate(
            withSentryConfigOptionsTemplate,
            sdkConfigOptions.withSentryConfigImportPath,
          );

      await promises.writeFile(
        path.join(process.cwd(), configFilename),
        configContent,
        { encoding: "utf8", flag: "w" },
      );

      clack.log.success(
        `Created ${chalk.cyan(configFilename)} with Sentry configuration.`,
      );

      return;
    }

    const [foundNextConfigFileType, foundNextConfigFileFilename] =
      foundNextConfigFile;

    if (foundNextConfigFileType === "js" || foundNextConfigFileType === "cjs") {
      Sentry.setTag("next-config-strategy", "modify");

      const nextConfigCjsContent = readFileSync(
        path.join(process.cwd(), foundNextConfigFileFilename),
        "utf8",
      );

      const probablyIncludesSdk =
        nextConfigCjsContent.includes("@sentry/nextjs") &&
        nextConfigCjsContent.includes("withSentryConfig");

      let shouldInject = true;

      if (probablyIncludesSdk) {
        const injectAnyhow = await abortIfCancelled(
          clack.confirm({
            message: `${chalk.cyan(
              foundNextConfigFileFilename,
            )} already contains Sentry SDK configuration. Should the wizard modify it anyways?`,
          }),
        );

        shouldInject = injectAnyhow;
      }

      if (shouldInject) {
        await promises.appendFile(
          path.join(process.cwd(), foundNextConfigFileFilename),
          getNextjsConfigCjsAppendix(
            withSentryConfigOptionsTemplate,
            sdkConfigOptions.withSentryConfigImportPath,
          ),
          "utf8",
        );

        clack.log.success(
          `Added Sentry configuration to ${chalk.cyan(
            foundNextConfigFileFilename,
          )}. ${chalk.dim("(you probably want to clean this up a bit!)")}`,
        );
      }

      Sentry.setTag("next-config-mod-result", "success");
    }

    if (
      foundNextConfigFileType === "mjs" ||
      foundNextConfigFileType === "mts" ||
      foundNextConfigFileType === "cts" ||
      foundNextConfigFileType === "ts"
    ) {
      const nextConfigMjsContent = readFileSync(
        path.join(process.cwd(), foundNextConfigFileFilename),
        "utf8",
      );

      const probablyIncludesSdk =
        nextConfigMjsContent.includes("@sentry/nextjs") &&
        nextConfigMjsContent.includes("withSentryConfig");

      let shouldInject = true;

      if (probablyIncludesSdk) {
        const injectAnyhow = await abortIfCancelled(
          clack.confirm({
            message: `${chalk.cyan(
              foundNextConfigFileFilename,
            )} already contains Sentry SDK configuration. Should the wizard modify it anyways?`,
          }),
        );

        shouldInject = injectAnyhow;
      }

      try {
        if (shouldInject) {
          const mod = parseModule(nextConfigMjsContent);
          addWithSentryConfigImport(
            mod,
            sdkConfigOptions.withSentryConfigImportPath,
          );

          if (probablyIncludesSdk) {
            // Prevent double wrapping like: withSentryConfig(withSentryConfig(nextConfig), { ... })
            // Use AST manipulation instead of string parsing for better reliability
            mod.exports["default"].$ast = unwrapSentryConfigAst(
              mod.exports["default"].$ast,
            );
          }

          // Use the shared utility function for wrapping
          mod.exports["default"] = wrapWithSentryConfig(
            mod.exports["default"],
            withSentryConfigOptionsTemplate,
          );

          let newCode = mod.generate().code;

          // Post-process to fix formatting issues that magicast doesn't handle
          // (needed for Biome/ESLint compatibility):
          // 1. Add spaces inside import braces for various import patterns
          // Single named import: {Foo} -> { Foo }
          newCode = newCode.replace(
            /import\s*{(\w+)}\s*from/g,
            "import { $1 } from",
          );
          // Multiple named imports: {Foo,Bar} or {Foo, Bar} -> { Foo, Bar }
          newCode = newCode.replace(
            /import\s*{([^}]+)}\s*from/g,
            (_match: string, imports: string) => {
              const formatted = imports
                .split(",")
                .map((i: string) => i.trim())
                .join(", ");
              return `import { ${formatted} } from`;
            },
          );
          // Default + named imports: Foo,{Bar} -> Foo, { Bar }
          newCode = newCode.replace(
            /import\s+(\w+)\s*,\s*{([^}]+)}\s*from/g,
            (_match: string, defaultImport: string, namedImports: string) => {
              const formatted = namedImports
                .split(",")
                .map((i: string) => i.trim())
                .join(", ");
              return `import ${defaultImport}, { ${formatted} } from`;
            },
          );
          // 2. Fix trailing comma and closing format for withSentryConfig call
          // Biome wants: automaticVercelMonitors: true,\n  });
          newCode = newCode.replace(
            /automaticVercelMonitors:\s*true,?\s*},?\s*\);/g,
            "automaticVercelMonitors: true,\n  });\n",
          );
          // 3. Ensure trailing newline
          if (!newCode.endsWith("\n")) {
            newCode += "\n";
          }

          await promises.writeFile(
            path.join(process.cwd(), foundNextConfigFileFilename),
            newCode,
            {
              encoding: "utf8",
              flag: "w",
            },
          );
          clack.log.success(
            `${
              probablyIncludesSdk ? "Updated" : "Added"
            } Sentry configuration ${
              probablyIncludesSdk ? "in" : "to"
            } ${chalk.cyan(foundNextConfigFileFilename)}. ${chalk.dim(
              "(you probably want to clean this up a bit!)",
            )}`,
          );

          Sentry.setTag("next-config-mod-result", "success");
        }
      } catch {
        Sentry.setTag("next-config-mod-result", "fail");
        clack.log.warn(
          chalk.yellow(
            `Something went wrong writing to ${chalk.cyan(
              foundNextConfigFileFilename,
            )}.`,
          ),
        );
        clack.log.info(
          `Please put the following code snippet into ${chalk.cyan(
            foundNextConfigFileFilename,
          )}: ${chalk.dim("You probably have to clean it up a bit.")}\n`,
        );
        clack.rawOutput(
          getNextjsConfigEsmCopyPasteSnippet(
            withSentryConfigOptionsTemplate,
            sdkConfigOptions.withSentryConfigImportPath,
          ),
        );

        const shouldContinue = await abortIfCancelled(
          clack.confirm({
            message: `Are you done putting the snippet above into ${chalk.cyan(
              foundNextConfigFileFilename,
            )}?`,
            active: "Yes",
            inactive: "No, get me out of here",
          }),
        );

        if (!shouldContinue) {
          await abort();
        }
      }
    }
  });
}

function hasDirectoryPathFromRoot(dirnameOrDirs: string | string[]): boolean {
  const dirPath = Array.isArray(dirnameOrDirs)
    ? path.join(process.cwd(), ...dirnameOrDirs)
    : path.join(process.cwd(), dirnameOrDirs);

  return existsSync(dirPath) && lstatSync(dirPath).isDirectory();
}

async function createExamplePage(
  selfHosted: boolean,
  selectedProject: SentryProjectData,
  sentryUrl: string,
  typeScriptDetected: boolean,
  nextVersion: string | undefined,
): Promise<void> {
  const hasSrcDirectory = hasDirectoryPathFromRoot("src");
  const hasRootAppDirectory = hasDirectoryPathFromRoot("app");
  const hasRootPagesDirectory = hasDirectoryPathFromRoot("pages");
  const hasSrcAppDirectory = hasDirectoryPathFromRoot(["src", "app"]);
  const hasSrcPagesDirectory = hasDirectoryPathFromRoot(["src", "pages"]);

  Sentry.setTag("nextjs-app-dir", hasRootAppDirectory || hasSrcAppDirectory);

  // If `pages` or an `app` directory exists in the root, we'll put the example page there.
  // `app` directory takes priority over `pages` directory when they coexist, so we prioritize that.
  // https://nextjs.org/docs/app/building-your-application/routing#the-app-router

  const appFolderLocation = hasRootAppDirectory
    ? ["app"]
    : hasSrcAppDirectory
      ? ["src", "app"]
      : undefined;

  let pagesFolderLocation = hasRootPagesDirectory
    ? ["pages"]
    : hasSrcPagesDirectory
      ? ["src", "pages"]
      : undefined;

  // If the user has neither pages nor app directory we create a pages folder for them
  if (!appFolderLocation && !pagesFolderLocation) {
    const newPagesFolderLocation = hasSrcDirectory
      ? ["src", "pages"]
      : ["pages"];
    mkdirSync(path.join(process.cwd(), ...newPagesFolderLocation), {
      recursive: true,
    });

    pagesFolderLocation = newPagesFolderLocation;
  }

  if (appFolderLocation) {
    const appFolderPath = path.join(process.cwd(), ...appFolderLocation);

    const hasRootLayout = hasRootLayoutFile(appFolderPath);

    if (!hasRootLayout) {
      // In case no root layout file exists, we create a simple one so that
      // the example page can be rendered correctly.
      const newRootLayoutFilename = `layout.${
        typeScriptDetected ? "tsx" : "jsx"
      }`;

      await promises.writeFile(
        path.join(appFolderPath, newRootLayoutFilename),
        getRootLayout(typeScriptDetected),
        { encoding: "utf8", flag: "w" },
      );

      clack.log.success(
        `Created ${chalk.cyan(
          path.join(...appFolderLocation, newRootLayoutFilename),
        )}.`,
      );
    }

    const examplePageContents = getSentryExamplePageContents({
      selfHosted,
      orgSlug: selectedProject.organization.slug,
      projectId: selectedProject.id,
      sentryUrl,
      useClient: true,
      isTypeScript: typeScriptDetected,
    });

    mkdirSync(path.join(appFolderPath, "sentry-example-page"), {
      recursive: true,
    });

    const newPageFileName = `page.${typeScriptDetected ? "tsx" : "jsx"}`;

    await promises.writeFile(
      path.join(appFolderPath, "sentry-example-page", newPageFileName),
      examplePageContents,
      { encoding: "utf8", flag: "w" },
    );

    clack.log.success(
      `Created ${chalk.cyan(
        path.join(...appFolderLocation, "sentry-example-page", newPageFileName),
      )}.`,
    );

    mkdirSync(path.join(appFolderPath, "api", "sentry-example-api"), {
      recursive: true,
    });

    const newRouteFileName = `route.${typeScriptDetected ? "ts" : "js"}`;

    await promises.writeFile(
      path.join(appFolderPath, "api", "sentry-example-api", newRouteFileName),
      getSentryExampleAppDirApiRoute({
        isTypeScript: typeScriptDetected,
        dynamicStrategy: getExampleApiRouteDynamicStrategy(nextVersion),
      }),
      { encoding: "utf8", flag: "w" },
    );

    clack.log.success(
      `Created ${chalk.cyan(
        path.join(
          ...appFolderLocation,
          "api",
          "sentry-example-api",
          newRouteFileName,
        ),
      )}.`,
    );
  } else if (pagesFolderLocation) {
    const examplePageContents = getSentryExamplePageContents({
      selfHosted,
      orgSlug: selectedProject.organization.slug,
      projectId: selectedProject.id,
      sentryUrl,
      useClient: false,
      isTypeScript: typeScriptDetected,
    });

    const examplePageFileName = `sentry-example-page.${
      typeScriptDetected ? "tsx" : "jsx"
    }`;

    await promises.writeFile(
      path.join(process.cwd(), ...pagesFolderLocation, examplePageFileName),
      examplePageContents,
      { encoding: "utf8", flag: "w" },
    );

    clack.log.success(
      `Created ${chalk.cyan(
        path.join(...pagesFolderLocation, examplePageFileName),
      )}.`,
    );

    mkdirSync(path.join(process.cwd(), ...pagesFolderLocation, "api"), {
      recursive: true,
    });

    const apiRouteFileName = `sentry-example-api.${
      typeScriptDetected ? "ts" : "js"
    }`;

    await promises.writeFile(
      path.join(process.cwd(), ...pagesFolderLocation, "api", apiRouteFileName),
      getSentryExamplePagesDirApiRoute({
        isTypeScript: typeScriptDetected,
      }),
      { encoding: "utf8", flag: "w" },
    );

    clack.log.success(
      `Created ${chalk.cyan(
        path.join(...pagesFolderLocation, "api", apiRouteFileName),
      )}.`,
    );
  }
}

/**
 * Ask users if they want to set the tunnelRoute option.
 * We can't set this by default because it potentially increases hosting bills.
 * It's valuable enough to for users to justify asking the additional question.
 */
async function askShouldSetTunnelRoute() {
  return await traceStep("ask-tunnelRoute-option", async (span) => {
    const shouldSetTunnelRoute = await abortIfCancelled(
      clack.select({
        message:
          "Do you want to route Sentry requests in the browser through your Next.js server to avoid ad blockers?",
        options: [
          {
            label: "Yes",
            value: true,
            hint: "Can increase your server load and hosting bill",
          },
          {
            label: "No",
            value: false,
            hint: "Browser errors and events might be blocked by ad blockers before being sent to Sentry",
          },
        ],
        initialValue: true,
      }),
    );

    if (!shouldSetTunnelRoute) {
      clack.log.info(
        "Sounds good! We'll leave the option commented for later, just in case :)",
      );
    }

    span?.setAttribute("tunnelRoute", shouldSetTunnelRoute);
    Sentry.setTag("tunnelRoute", shouldSetTunnelRoute);

    return shouldSetTunnelRoute;
  });
}

/**
 * Returns true or false depending on whether we think the user is using Turbopack. May return null in case we aren't sure.
 */
async function checkIfLikelyIsUsingTurbopack(): Promise<boolean | null> {
  let packageJsonContent: string;
  try {
    packageJsonContent = await promises.readFile(
      path.join(process.cwd(), "package.json"),
      "utf8",
    );
  } catch (error) {
    debug(error);
    return null;
  }

  return packageJsonContent.includes("--turbo");
}
