/**
 * The Flutter wizard: adds `sentry_flutter` and `sentry_dart_plugin` to
 * `pubspec.yaml`, writes the plugin's `sentry.properties` with the auth
 * token, and patches `main.dart` with `SentryFlutter.init` and a test error.
 * Ported from sentry-wizard's `src/flutter`.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { Sentry, traceStep, withTelemetry } from "../telemetry.js";
import { abortIfSpotlightNotSupported } from "../utils/abort-if-sportlight-not-supported.js";
import {
  confirmContinueIfNoOrDirtyGitRepo,
  getOrAskForProjectData,
  printWelcome,
  showCopyPasteInstructions,
} from "../utils/clack/index.js";
import { offerProjectScopedMcpConfig } from "../utils/clack/mcp-config.js";
import { clack } from "../utils/clack/prompts.js";
import { fixLineEndings } from "../utils/line-endings.js";
import { fetchSdkVersion } from "../utils/release-registry.js";
import type { WizardOptions } from "../utils/types.js";
import {
  addProperties,
  findFile,
  patchMain,
  patchPubspec,
} from "./code-tools.js";
import { initSnippetColored, pubspecSnippetColored } from "./templates.js";

/** Docs on how the Sentry Dart plugin reads its auth token. */
const DART_PLUGIN_AUTH_TOKEN_DOCS =
  "https://docs.sentry.io/platforms/dart/guides/flutter/debug-symbols/dart-plugin/#set-your-auth-token";

/** Run the Flutter wizard in its telemetry span. */
export async function runFlutterWizard(options: WizardOptions): Promise<void> {
  return await withTelemetry(
    {
      enabled: options.telemetryEnabled,
      integration: "flutter",
      wizardOptions: options,
    },
    () => runFlutterWizardWithTelemetry(options),
  );
}

async function runFlutterWizardWithTelemetry(
  options: WizardOptions,
): Promise<void> {
  printWelcome({
    wizardName: "Sentry Flutter Wizard",
  });

  await confirmContinueIfNoOrDirtyGitRepo({
    ignoreGitChanges: options.ignoreGitChanges,
    cwd: undefined,
  });

  const projectData = await getOrAskForProjectData(options, "flutter");

  if (projectData.spotlight) {
    return await abortIfSpotlightNotSupported("Flutter");
  }

  const { selectedProject, selfHosted, sentryUrl, authToken } = projectData;

  const projectDir = process.cwd();
  const pubspecFile = path.join(projectDir, "pubspec.yaml");
  if (!existsSync(pubspecFile)) {
    clack.log.error(
      `Could not find ${chalk.cyan(
        "pubspec.yaml",
      )}. Make sure you run the wizard in the projects root folder.`,
    );
    return;
  }

  // ======== STEP 1. Add sentry_flutter and sentry_dart_plugin to pubspec.yaml ============

  clack.log.step(
    `Adding ${chalk.bold("Sentry")} to your apps ${chalk.cyan(
      "pubspec.yaml",
    )} file.`,
  );

  const flutterVersion = await fetchSdkVersion("sentry.dart.flutter");
  const flutterVersionOrAny = flutterVersion ? `^${flutterVersion}` : "any";

  const pluginVersion = await fetchSdkVersion("sentry.dart.plugin");
  const pluginVersionOrAny = pluginVersion ? `^${pluginVersion}` : "any";

  const pubspecPatched = traceStep("Patch pubspec.yaml", () =>
    patchPubspec(
      pubspecFile,
      flutterVersionOrAny,
      pluginVersionOrAny,
      selectedProject.slug,
      selectedProject.organization.slug,
    ),
  );
  if (!pubspecPatched) {
    clack.log.warn(
      `Could not patch ${chalk.cyan(
        "pubspec.yaml",
      )}. Add the dependencies to it.`,
    );
    await showCopyPasteInstructions({
      filename: "pubspec.yaml",
      codeSnippet: pubspecSnippetColored(
        flutterVersionOrAny,
        pluginVersionOrAny,
        selectedProject.slug,
        selectedProject.organization.slug,
      ),
      hint: "This ensures the Sentry SDK and plugin can be imported.",
    });
  }
  Sentry.setTag("pubspec-patched", pubspecPatched);

  // ======== STEP 2. Add sentry.properties with auth token ============

  const propertiesAdded = traceStep("Add sentry.properties", () =>
    addProperties(pubspecFile, authToken),
  );
  if (!propertiesAdded) {
    clack.log.warn(
      `We could not add ${chalk.cyan(
        "sentry.properties",
      )} file in your project directory in order to provide an auth token for the Sentry Dart plugin. You'll have to add it manually, or you can set the SENTRY_AUTH_TOKEN environment variable instead. See ${DART_PLUGIN_AUTH_TOKEN_DOCS} for more information.`,
    );
  } else {
    clack.log.info(
      `Created a ${chalk.cyan(
        "sentry.properties",
      )} file in your project directory to provide an auth token for the Sentry Dart plugin.
It was also added to your ${chalk.cyan(".gitignore")} file.
Set the ${chalk.cyan(
        "SENTRY_AUTH_TOKEN",
      )} environment variable in your CI environment. See ${DART_PLUGIN_AUTH_TOKEN_DOCS} for more information.`,
    );
  }
  Sentry.setTag("sentry-properties-added", propertiesAdded);

  // ======== STEP 3. Patch main.dart with setup and a test error snippet ============

  clack.log.step(
    `Next, the wizard will patch your ${chalk.cyan(
      "main.dart",
    )} file with the SDK init and a test error snippet.`,
  );

  const mainFile = findFile(`${projectDir}/lib`, "main.dart");
  const dsn = selectedProject.keys[0].dsn.public;
  const mainPatched = await traceStep("Patch main.dart", () =>
    patchMain(mainFile, dsn),
  );
  if (!mainPatched) {
    clack.log.warn(
      `Could not patch ${chalk.cyan(
        "main.dart",
      )} file. Place the following code snippet within the apps main function.`,
    );
    await showCopyPasteInstructions({
      filename: "main.dart",
      codeSnippet: initSnippetColored(dsn),
      hint: "This ensures the Sentry SDK is ready to capture errors.",
    });
  }
  Sentry.setTag("main-patched", mainPatched);

  // ======== OUTRO ========

  // Offer optional project-scoped MCP config for Sentry with org and project scope
  await offerProjectScopedMcpConfig(
    selectedProject.organization.slug,
    selectedProject.slug,
  );

  // Fix mixed line endings caused by inserting LF content into CRLF files (Windows)
  fixLineEndings();

  const issuesPageLink = selfHosted
    ? `${sentryUrl}organizations/${selectedProject.organization.slug}/issues/?project=${selectedProject.id}`
    : `https://${selectedProject.organization.slug}.sentry.io/issues/?project=${selectedProject.id}`;

  clack.outro(`${chalk.greenBright(
    "Successfully installed the Sentry Flutter SDK!",
  )}
    
    ${chalk.cyan("Next steps:")}
    1. Run ${chalk.bold(
      "flutter run",
    )} to test the setup - we've added a test error that will trigger on app start
    2. For production builds, run ${chalk.bold(
      "flutter build apk --obfuscate --split-debug-info=build/debug-info",
    )} (or ios/macos) then ${chalk.bold(
      "flutter pub run sentry_dart_plugin",
    )} to upload debug symbols
    3. View your test error and transaction data at ${issuesPageLink}
    
    ${chalk.cyan("Learn more:")}
    - Debug Symbols: https://docs.sentry.io/platforms/dart/guides/flutter/debug-symbols/
    - Performance Monitoring: https://docs.sentry.io/platforms/dart/guides/flutter/performance/
    - Integrations: https://docs.sentry.io/platforms/dart/guides/flutter/integrations/
  `);
}
