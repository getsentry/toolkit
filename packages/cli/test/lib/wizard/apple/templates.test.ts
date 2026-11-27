import { describe, expect, it, vi } from "vitest";
import {
  getFastlaneSnippet,
  getObjcSnippet,
  getRunScriptTemplate,
  getSwiftSnippet,
  isSentryUploadScript,
  scriptInputPath,
} from "../../../../src/lib/wizard/apple/templates.js";

vi.mock("../../../../src/lib/wizard/utils/clack/mcp-config.js", () => ({
  offerProjectScopedMcpConfig: vi.fn().mockResolvedValue(undefined),
}));

describe("templates", () => {
  describe("getRunScriptTemplate", () => {
    const variations: {
      uploadSource: boolean;
      expectedScript: string;
    }[] = [
      {
        uploadSource: true,
        expectedScript: `# This script is responsible for uploading debug symbols and source context for Sentry.
# Xcode doesn't use your shell's PATH; add the Sentry CLI installer's and Homebrew's directories.
export PATH="$HOME/.local/bin:$HOME/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

export SENTRY_ORG=test-org
export SENTRY_PROJECT=test-project
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
if ! ERROR=$("$@" debug-files upload --include-sources "$DWARF_DSYM_FOLDER_PATH" 2>&1 >/dev/null); then
  echo "warning: sentry - $ERROR"
fi
`,
      },
      {
        uploadSource: false,
        expectedScript: `# This script is responsible for uploading debug symbols and source context for Sentry.
# Xcode doesn't use your shell's PATH; add the Sentry CLI installer's and Homebrew's directories.
export PATH="$HOME/.local/bin:$HOME/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

export SENTRY_ORG=test-org
export SENTRY_PROJECT=test-project
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
if ! ERROR=$("$@" debug-files upload "$DWARF_DSYM_FOLDER_PATH" 2>&1 >/dev/null); then
  echo "warning: sentry - $ERROR"
fi
`,
      },
    ];

    for (const variation of variations) {
      describe(`uploadSource: ${variation.uploadSource.toString()}`, () => {
        it("should return the correct script", () => {
          // -- Act --
          const script = getRunScriptTemplate(
            "test-org",
            "test-project",
            variation.uploadSource,
          );

          // -- Assert --
          expect(script).toBe(variation.expectedScript);
        });
      });
    }

    it("passes no --org or --project flags and never calls sentry-cli", () => {
      const script = getRunScriptTemplate("test-org", "test-project", true);

      expect(script).not.toMatch(/--org|--project|sentry-cli/);
    });
  });

  describe("isSentryUploadScript", () => {
    it("matches the generated v4 script", () => {
      expect(
        isSentryUploadScript(
          getRunScriptTemplate("test-org", "test-project", false),
        ),
      ).toBe(true);
    });

    it("matches an older sentry-cli upload phase", () => {
      expect(
        isSentryUploadScript(
          'sentry-cli debug-files upload "$DWARF_DSYM_FOLDER_PATH"',
        ),
      ).toBe(true);
    });

    it("does not match unrelated scripts", () => {
      expect(isSentryUploadScript("swiftlint lint")).toBe(false);
    });
  });

  describe("scriptInputPath", () => {
    it("should return the correct path", () => {
      expect(scriptInputPath).toBe(
        '"${DWARF_DSYM_FOLDER_PATH}/${DWARF_DSYM_FILE_NAME}/Contents/Resources/DWARF/${TARGET_NAME}"',
      );
    });
  });

  describe("getSwiftSnippet", () => {
    it("should return the correct snippet", () => {
      // -- Arrange --
      const snippet = getSwiftSnippet("test-dsn", false);

      // -- Assert --
      expect(snippet).toBe(
        `        SentrySDK.start { options in
            options.dsn = "test-dsn"

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
            // options.attachViewHierarchy = true // This adds the view hierarchy to the error events
        }
        // Remove the next line after confirming that your Sentry integration is working.
        SentrySDK.capture(message: "This app uses Sentry! :)")
`,
      );
    });

    it("should return the correct snippet with logs enabled", () => {
      // -- Arrange --
      const snippet = getSwiftSnippet("test-dsn", true);

      // -- Assert --
      expect(snippet).toBe(
        `        SentrySDK.start { options in
            options.dsn = "test-dsn"

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
            // options.attachViewHierarchy = true // This adds the view hierarchy to the error events
            
            // Enable experimental logging features
            options.experimental.enableLogs = true
        }
        // Remove the next line after confirming that your Sentry integration is working.
        SentrySDK.capture(message: "This app uses Sentry! :)")
`,
      );
    });
  });

  describe("getObjcSnippet", () => {
    it("should return the correct snippet", () => {
      // -- Arrange --
      const snippet = getObjcSnippet("test-dsn", false);

      // -- Assert --
      expect(snippet).toBe(
        `    [SentrySDK startWithConfigureOptions:^(SentryOptions * options) {
        options.dsn = @"test-dsn";

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
        //options.attachViewHierarchy = YES; //This will add the view hierarchy to the error events
    }];
    //Remove the next line after confirming that your Sentry integration is working.
    [SentrySDK captureMessage:@"This app uses Sentry!"];
`,
      );
    });

    it("should return the correct snippet with logs enabled", () => {
      // -- Arrange --
      const snippet = getObjcSnippet("test-dsn", true);

      // -- Assert --
      expect(snippet).toBe(
        `    [SentrySDK startWithConfigureOptions:^(SentryOptions * options) {
        options.dsn = @"test-dsn";

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
        //options.attachViewHierarchy = YES; //This will add the view hierarchy to the error events
        
        // Enable experimental logging features
        options.experimental.enableLogs = YES;
    }];
    //Remove the next line after confirming that your Sentry integration is working.
    [SentrySDK captureMessage:@"This app uses Sentry!"];
`,
      );
    });
  });

  describe("getFastlaneSnippet", () => {
    it("should return the correct snippet", () => {
      // -- Arrange --
      const snippet = getFastlaneSnippet("test-org", "test-project");

      // -- Assert --
      expect(snippet).toBe(
        `    sentry_debug_files_upload(
      org_slug: 'test-org',
      project_slug: 'test-project',
      include_sources: true
    )`,
      );
    });
  });
});
