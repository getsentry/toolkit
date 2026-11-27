/**
 * The React Router (framework mode) setup wizard: installs
 * `@sentry/react-router`, instruments the client and server entries, the
 * Vite and React Router configs, and optionally adds an example page.
 */

import { clack } from "../utils/clack/prompts.js";
import chalk from "chalk";
import { Sentry } from "../telemetry.js";

import type { WizardOptions } from "../utils/types.js";
import { withTelemetry, traceStep } from "../telemetry.js";
import {
  askShouldCreateExamplePage,
  confirmContinueIfNoOrDirtyGitRepo,
  featureSelectionPrompt,
  getOrAskForProjectData,
  getPackageDotJson,
  isUsingTypeScript,
  printWelcome,
  installPackage,
  printSdkV11MigrationGuideIfOutdated,
  addDotEnvSentryBuildPluginFile,
  showCopyPasteInstructions,
  runPrettierIfInstalled,
} from "../utils/clack/index.js";
import { offerProjectScopedMcpConfig } from "../utils/clack/mcp-config.js";
import {
  getPackageVersion,
  hasPackageInstalled,
} from "../utils/package-json.js";
import {
  MIN_REACT_ROUTER_VERSION_FOR_SDK_V11,
  SENTRY_REACT_ROUTER_SDK_RANGE,
  getSentryReactRouterVitePluginImportPath,
} from "./sdk-version.js";
import { debug } from "../utils/debug.js";
import { getReactRouterConfigFilename } from "./codemods/react-router-config.js";
import { getViteConfigFilename } from "./codemods/vite.js";
import { createExamplePage } from "./sdk-example.js";
import {
  isReactRouterV7,
  getReactRouterVersion,
  supportsInstrumentationAPI,
  supportsOnError,
  runReactRouterReveal,
  initializeSentryOnEntryClient,
  createServerInstrumentationFile,
  updatePackageJsonScripts,
  instrumentSentryOnEntryServer,
  configureReactRouterConfig,
  configureReactRouterVitePlugin,
  getEntryFilename,
} from "./sdk-setup.js";
import {
  getManualClientEntryContent,
  getManualServerEntryContent,
  getManualServerInstrumentContent,
  getManualReactRouterConfigContent,
  getManualViteConfigContent,
  getManualPackageJsonScriptsContent,
} from "./templates.js";
import { abortIfSpotlightNotSupported } from "../utils/abort-if-sportlight-not-supported.js";
import {
  askShouldReduceDataCollection,
  sdkSupportsDataCollection,
} from "../utils/data-collection.js";
import { warnIfNodeVersionUnsupportedBySdkV11 } from "../utils/node-version.js";

export async function runReactRouterWizard(
  options: WizardOptions,
): Promise<void> {
  return await withTelemetry(
    {
      enabled: options.telemetryEnabled,
      integration: "reactRouter",
      wizardOptions: options,
    },
    () => runReactRouterWizardWithTelemetry(options),
  );
}

async function runReactRouterWizardWithTelemetry(
  options: WizardOptions,
): Promise<void> {
  printWelcome({
    wizardName: "Sentry React Router Wizard",
    telemetryEnabled: options.telemetryEnabled,
  });

  const packageJson = await getPackageDotJson();

  const typeScriptDetected = isUsingTypeScript();

  if (!isReactRouterV7(packageJson)) {
    clack.log.error(
      "This wizard requires React Router v7. Please upgrade your React Router version to v7.0.0 or higher.\n\nFor upgrade instructions, visit: https://react-router.dev/upgrade/v7",
    );
    return;
  }

  warnIfNodeVersionUnsupportedBySdkV11();

  await confirmContinueIfNoOrDirtyGitRepo({
    ignoreGitChanges: options.ignoreGitChanges,
    cwd: undefined,
  });

  const sentryAlreadyInstalled = hasPackageInstalled(
    "@sentry/react-router",
    packageJson,
  );

  const projectData = await getOrAskForProjectData(
    options,
    "javascript-react-router",
  );

  if (projectData.spotlight) {
    return await abortIfSpotlightNotSupported("React Router");
  }

  const { selectedProject, authToken, selfHosted, sentryUrl } = projectData;

  printSdkV11MigrationGuideIfOutdated("@sentry/react-router", packageJson);

  await installPackage({
    packageName: `@sentry/react-router@${SENTRY_REACT_ROUTER_SDK_RANGE}`,
    packageNameDisplayLabel: "@sentry/react-router",
    alreadyInstalled: sentryAlreadyInstalled,
    forceInstall: options.forceInstall,
  });

  // The install may have been skipped (user declined the update prompt), so
  // re-read package.json to learn which SDK major is actually installed.
  const installedSdkVersion = getPackageVersion(
    "@sentry/react-router",
    await getPackageDotJson(),
  );
  const vitePluginImportPath =
    getSentryReactRouterVitePluginImportPath(installedSdkVersion);

  // From v11 on, the SDK collects rich context by default, so offer to
  // reduce collection of data that can identify users.
  const reduceDataCollection =
    sdkSupportsDataCollection(
      installedSdkVersion,
      SENTRY_REACT_ROUTER_SDK_RANGE,
    ) && (await askShouldReduceDataCollection());

  if (!supportsInstrumentationAPI(packageJson)) {
    clack.log.warn(
      `${chalk.yellow(
        `Version 11 of the Sentry React Router SDK requires React Router ${MIN_REACT_ROUTER_VERSION_FOR_SDK_V11} or newer, but this project uses ${chalk.bold(
          `react-router@${getReactRouterVersion(packageJson) ?? "unknown"}`,
        )}.`,
      )}
The wizard will continue, but you may need to upgrade React Router before moving to SDK v11.`,
    );
  }

  const featureSelection = await featureSelectionPrompt([
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
    {
      id: "profiling",
      prompt: `Do you want to enable ${chalk.bold(
        "Profiling",
      )} to track application performance in detail?`,
      enabledHint: "recommended for production debugging",
    },
  ] as const);

  // Only ask about Instrumentation API when Tracing is enabled, since it depends on it
  let instrumentationAPISelected = false;
  if (featureSelection.performance) {
    const instrumentationAPISelection = await featureSelectionPrompt([
      {
        id: "instrumentationAPI",
        prompt: `Do you want to use the ${chalk.bold(
          "Instrumentation API",
        )} for automatic tracing of loaders, actions, and middleware?`,
        enabledHint: "recommended",
      },
    ] as const);
    instrumentationAPISelected = instrumentationAPISelection.instrumentationAPI;
  }

  if (featureSelection.profiling) {
    const profilingAlreadyInstalled = hasPackageInstalled(
      "@sentry/profiling-node",
      packageJson,
    );

    await installPackage({
      packageName: `@sentry/profiling-node@${SENTRY_REACT_ROUTER_SDK_RANGE}`,
      packageNameDisplayLabel: "@sentry/profiling-node",
      alreadyInstalled: profilingAlreadyInstalled,
      forceInstall: options.forceInstall,
    });
  }

  const createExamplePageSelection = await askShouldCreateExamplePage();

  traceStep("Reveal missing entry files", () => {
    try {
      runReactRouterReveal();
      clack.log.success("Entry files are ready for instrumentation");
    } catch (e) {
      clack.log.warn(`Could not run 'npx react-router reveal'.
Please create your entry files manually using React Router v7 commands.`);
      debug(e);
    }
  });

  Sentry.setTag("instrumentation-api-selected", instrumentationAPISelected);

  let useInstrumentationAPI = instrumentationAPISelected;

  if (useInstrumentationAPI && !supportsInstrumentationAPI(packageJson)) {
    Sentry.setTag("instrumentation-api-version-guard", true);
    const detectedVersion = getReactRouterVersion(packageJson) ?? "unknown";
    clack.log.warn(
      `The Instrumentation API requires React Router ${chalk.cyan(
        ">=7.15.0",
      )} (detected ${chalk.cyan(
        detectedVersion,
      )}). Your version does not meet this requirement.\n` +
        `Continuing without the Instrumentation API. Please upgrade React Router to use this feature:\n` +
        chalk.dim(
          "https://docs.sentry.io/platforms/javascript/guides/react-router/",
        ),
    );
    useInstrumentationAPI = false;
  }

  Sentry.setTag("use-instrumentation-api", useInstrumentationAPI);

  let useOnError = true;

  if (!supportsOnError(packageJson)) {
    Sentry.setTag("on-error-version-guard", true);
    const detectedVersion = getReactRouterVersion(packageJson) ?? "unknown";
    clack.log.warn(
      `The ${chalk.cyan(
        "onError",
      )} prop on HydratedRouter requires React Router ${chalk.cyan(
        ">=7.11.0",
      )} (detected ${chalk.cyan(detectedVersion)}).\n` +
        `Skipping automatic error handler setup. Please upgrade React Router and follow the manual setup guide:\n` +
        chalk.dim(
          "https://docs.sentry.io/platforms/javascript/guides/react-router/",
        ),
    );
    useOnError = false;
  }

  Sentry.setTag("use-on-error", useOnError);

  await traceStep("Initialize Sentry on client entry", async () => {
    try {
      await initializeSentryOnEntryClient(
        selectedProject.keys[0].dsn.public,
        featureSelection.performance,
        featureSelection.replay,
        typeScriptDetected,
        reduceDataCollection,
        useInstrumentationAPI,
        useOnError,
      );
    } catch (e) {
      clack.log.warn(
        `Could not initialize Sentry on client entry automatically.`,
      );

      const clientEntryFilename = getEntryFilename(
        "entry.client",
        typeScriptDetected,
      );

      const manualClientContent = getManualClientEntryContent(
        selectedProject.keys[0].dsn.public,
        featureSelection.performance,
        featureSelection.replay,
        reduceDataCollection,
        useInstrumentationAPI,
        useOnError,
      );

      await showCopyPasteInstructions({
        filename: clientEntryFilename,
        codeSnippet: manualClientContent,
        hint: "This enables error tracking and performance monitoring for your React Router app",
      });

      debug(e);
    }
  });

  await traceStep("Instrument server entry", async () => {
    try {
      await instrumentSentryOnEntryServer(
        typeScriptDetected,
        useInstrumentationAPI,
      );
    } catch (e) {
      clack.log.warn(
        `Could not initialize Sentry on server entry automatically.`,
      );

      const serverEntryFilename = getEntryFilename(
        "entry.server",
        typeScriptDetected,
      );
      const manualServerContent = getManualServerEntryContent(
        useInstrumentationAPI,
      );

      await showCopyPasteInstructions({
        filename: serverEntryFilename,
        codeSnippet: manualServerContent,
        hint: "This configures server-side request handling and error tracking",
      });

      debug(e);
    }
  });

  await traceStep("Create server instrumentation file", async () => {
    try {
      createServerInstrumentationFile(
        selectedProject.keys[0].dsn.public,
        {
          performance: featureSelection.performance,
          replay: featureSelection.replay,
          profiling: featureSelection.profiling,
        },
        reduceDataCollection,
      );
    } catch (e) {
      clack.log.warn(
        "Could not create a server instrumentation file automatically.",
      );

      const manualServerInstrumentContent = getManualServerInstrumentContent(
        selectedProject.keys[0].dsn.public,
        featureSelection.performance,
        featureSelection.profiling,
        reduceDataCollection,
      );

      await showCopyPasteInstructions({
        filename: "instrument.server.mjs",
        codeSnippet: manualServerInstrumentContent,
        hint: "Create the file if it does not exist - this initializes Sentry before your application starts",
      });

      debug(e);
    }
  });

  await traceStep("Update package.json scripts", async () => {
    try {
      await updatePackageJsonScripts();
    } catch (e) {
      clack.log.warn("Could not update start script automatically.");

      await showCopyPasteInstructions({
        filename: "package.json",
        codeSnippet: getManualPackageJsonScriptsContent(),
      });

      debug(e);
    }
  });

  await traceStep("Create build plugin env file", async () => {
    try {
      await addDotEnvSentryBuildPluginFile(authToken);
    } catch (e) {
      clack.log.warn(
        "Could not create .env.sentry-build-plugin file. Please create it manually.",
      );
      debug(e);
    }
  });

  // Validate auth token before configuring sourcemap uploads
  if (!authToken) {
    clack.log.warn(
      `${chalk.yellow(
        "Warning:",
      )} No auth token found. Sourcemap uploads will not work without ${chalk.cyan(
        "SENTRY_AUTH_TOKEN",
      )}.\n` +
        `Please set ${chalk.cyan("SENTRY_AUTH_TOKEN")} in your ${chalk.cyan(
          ".env.sentry-build-plugin",
        )} file or environment variables.`,
    );
  }

  // Configure Vite plugin for sourcemap uploads
  await traceStep("Configure Vite plugin for sourcemap uploads", async () => {
    try {
      await configureReactRouterVitePlugin(
        selectedProject.organization.slug,
        selectedProject.slug,
        vitePluginImportPath,
      );
    } catch (e) {
      clack.log.warn(
        `Could not configure Vite plugin for sourcemap uploads automatically.`,
      );

      await showCopyPasteInstructions({
        filename: getViteConfigFilename(typeScriptDetected),
        codeSnippet: getManualViteConfigContent(
          selectedProject.organization.slug,
          selectedProject.slug,
          vitePluginImportPath,
        ),
        hint: "This enables automatic sourcemap uploads during build for better error tracking",
      });

      debug(e);
    }
  });

  // Configure React Router config for build hook
  await traceStep("Configure React Router build hook", async () => {
    try {
      await configureReactRouterConfig(
        typeScriptDetected,
        vitePluginImportPath,
      );
    } catch (e) {
      clack.log.warn(
        `Could not configure React Router build hook automatically.`,
      );

      const configFilename = getReactRouterConfigFilename(typeScriptDetected);
      await showCopyPasteInstructions({
        filename: configFilename,
        codeSnippet: getManualReactRouterConfigContent(
          configFilename.endsWith(".ts"),
          vitePluginImportPath,
        ),
        hint: "This enables automatic sourcemap uploads at the end of the build process",
      });

      debug(e);
    }
  });

  // Create example page if requested
  if (createExamplePageSelection) {
    await traceStep("Create example page", async () => {
      await createExamplePage({
        selfHosted,
        orgSlug: selectedProject.organization.slug,
        projectId: selectedProject.id,
        url: sentryUrl,
        isTS: typeScriptDetected,
        projectDir: process.cwd(),
      });
    });
  }

  await runPrettierIfInstalled({ cwd: undefined });

  // Offer optional project-scoped MCP config for Sentry with org and project scope
  await offerProjectScopedMcpConfig(
    selectedProject.organization.slug,
    selectedProject.slug,
  );

  clack.outro(
    `${chalk.green("Successfully installed the Sentry React Router SDK!")}${
      createExamplePageSelection
        ? `\n\nYou can validate your setup by visiting ${chalk.cyan(
            '"/sentry-example-page"',
          )} in your application.`
        : ""
    }`,
  );
}
