/**
 * The Xcode build phase that uploads debug symbols with `sentry debug-files
 * upload`. Xcode doesn't use the user's shell `PATH`, so the script adds the
 * standalone installer's and Homebrew's directories before looking for
 * `sentry`. Without an installed `sentry`, it runs the CLI from npm with
 * `npx`, which downloads it on the first build.
 *
 * The upload passes no `--org` or `--project`: `sentry` reads them from
 * `SENTRY_ORG` and `SENTRY_PROJECT`, which the script exports because CI has
 * no `.sentryclirc` (it is gitignored). Upload failures are Xcode warnings,
 * never build failures.
 */
export function getRunScriptTemplate(
  orgSlug: string,
  projectSlug: string,
  uploadSource: boolean,
): string {
  // oxlint-disable-next-line sentry-cli/no-hardcoded-sentry-command -- Xcode runs this script with the installed `sentry`, not the process running the wizard.
  return `# This script is responsible for uploading debug symbols and source context for Sentry.
# Xcode doesn't use your shell's PATH; add the Sentry CLI installer's and Homebrew's directories.
export PATH="$HOME/.local/bin:$HOME/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

export SENTRY_ORG=${orgSlug}
export SENTRY_PROJECT=${projectSlug}
# The check skips unrelated sentry binaries, such as the self-hosted Sentry server's.
if sentry debug-files --help >/dev/null 2>&1; then
  set -- sentry
elif command -v npx >/dev/null 2>&1; then
  # No installed Sentry CLI: run it from npm, downloaded on the first build.
  set -- npx --yes sentry
else
  echo "warning: Sentry CLI not installed. Install it with: curl https://cli.sentry.dev/install -fsS | bash (see https://cli.sentry.dev/getting-started/)"
  exit 0
fi
if ! ERROR=$("$@" debug-files upload ${
    uploadSource ? "--include-sources " : ""
  }"$DWARF_DSYM_FOLDER_PATH" 2>&1 >/dev/null); then
  echo "warning: sentry - $ERROR"
fi
`;
}

/**
 * Whether `shellScript` is a Sentry debug-file upload build phase: one that
 * runs `debug-files upload` (the wizard's, which picks `sentry` or `npx
 * sentry` first), or an older one that runs `sentry-cli`.
 */
export function isSentryUploadScript(shellScript: string): boolean {
  return (
    shellScript.includes("sentry-cli") ||
    /\bdebug-files\s+upload\b/.test(shellScript)
  );
}

export const scriptInputPath =
  '"${DWARF_DSYM_FOLDER_PATH}/${DWARF_DSYM_FILE_NAME}/Contents/Resources/DWARF/${TARGET_NAME}"';

export function getSwiftSnippet(dsn: string, enableLogs: boolean): string {
  let snippet = `        SentrySDK.start { options in
            options.dsn = "${dsn}"

            // Adds IP for users.
            // For more information, visit: https://docs.sentry.io/platforms/apple/data-management/data-collected/
            options.sendDefaultPii = true

            // Set tracesSampleRate to 1.0 to capture 100% of transactions for performance monitoring.
            // We recommend adjusting this value in production.
            options.tracesSampleRate = 1.0

            // Configure profiling. Visit https://docs.sentry.io/platforms/apple/profiling/ to learn more.
            options.configureProfiling = {
                $0.sessionSampleRate = 1.0 // We recommend adjusting this value in production.
                $0.lifecycle = .trace
            }

            // Uncomment the following lines to add more data to your events
            // options.attachScreenshot = true // This adds a screenshot to the error events
            // options.attachViewHierarchy = true // This adds the view hierarchy to the error events`;

  if (enableLogs) {
    snippet += `
            
            // Enable experimental logging features
            options.experimental.enableLogs = true`;
  }

  snippet += `
        }
        // Remove the next line after confirming that your Sentry integration is working.
        SentrySDK.capture(message: "This app uses Sentry! :)")\n`;

  return snippet;
}

export function getObjcSnippet(dsn: string, enableLogs: boolean): string {
  let snippet = `    [SentrySDK startWithConfigureOptions:^(SentryOptions * options) {
        options.dsn = @"${dsn}";

        // Adds IP for users.
        // For more information, visit: https://docs.sentry.io/platforms/apple/data-management/data-collected/
        options.sendDefaultPii = YES;

        // Set tracesSampleRate to 1.0 to capture 100% of transactions for performance monitoring.
        // We recommend adjusting this value in production.
        options.tracesSampleRate = @1.0;

        // Configure profiling. Visit https://docs.sentry.io/platforms/apple/profiling/ to learn more.
        options.configureProfiling = ^(SentryProfileOptions *profiling) {
            profiling.sessionSampleRate = 1.0; // We recommend adjusting this value in production.
            profiling.lifecycle = SentryProfilingLifecycleTrace;
        };

        //Uncomment the following lines to add more data to your events
        //options.attachScreenshot = YES; //This will add a screenshot to the error events
        //options.attachViewHierarchy = YES; //This will add the view hierarchy to the error events`;

  if (enableLogs) {
    snippet += `
        
        // Enable experimental logging features
        options.experimental.enableLogs = YES;`;
  }

  snippet += `
    }];
    //Remove the next line after confirming that your Sentry integration is working.
    [SentrySDK captureMessage:@"This app uses Sentry!"];\n`;

  return snippet;
}

export function getFastlaneSnippet(org: string, project: string): string {
  return `    sentry_debug_files_upload(
      org_slug: '${org}',
      project_slug: '${project}',
      include_sources: true
    )`;
}
