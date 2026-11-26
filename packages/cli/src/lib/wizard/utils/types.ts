/**
 * Types shared by the setup wizards: the options `sentry wizard` passes to a
 * flow, the Sentry project a flow sets up, and feature prompts.
 */

import type { ParsedOrgProject } from "../../arg-parsing.js";

export interface SentryProjectData {
  id: string;
  slug: string;
  organization: {
    id: string;
    name: string;
    slug: string;
  };
  keys: [{ dsn: { public: string } }];
}

export type PreselectedProject = {
  project: SentryProjectData;
  authToken: string;
  selfHosted: boolean;
};

export type WizardOptions = {
  /**
   * Controls whether the wizard should send telemetry data to Sentry.
   */
  telemetryEnabled: boolean;

  /**
   * The org and project from `sentry wizard <org>/<project>`, resolved after
   * the login: an org and project skip both pickers, an org (`<org>/`) skips
   * the org picker. Unset or auto-detect: the user picks both.
   */
  target?: ParsedOrgProject | undefined;

  /**
   * If this is set, the wizard will skip the login and project selection step.
   */
  preSelectedProject?: PreselectedProject | undefined;

  /**
   * Force-install the SDK package to continue with the installation in case
   * any package manager checks are failing (e.g. peer dependency versions).
   *
   * Use with caution and only if you know what you're doing.
   *
   * Does not apply to all wizard flows (currently NPM only)
   */
  forceInstall?: boolean | undefined;

  /**
   * If this is set, the wizard will ignore any git changes in the project and not prompt for confirmation.
   * `sentry wizard --force` sets it, together with {@link forceInstall}.
   */
  ignoreGitChanges?: boolean | undefined;

  /**
   * Enable Spotlight mode for local development without Sentry authentication.
   * When enabled:
   * - Skips login and project selection
   * - Uses empty DSN
   * - Skips auth token file creation
   * `sentry wizard` turns it on when `SENTRY_SPOTLIGHT` is set.
   */
  spotlight?: boolean | undefined;

  /**
   * Directory that contains the Xcode project, for the Apple wizards.
   * Defaults to the current directory. Passed via `--xcode-project-dir`.
   */
  xcodeProjectDir?: string | undefined;

  /**
   * Xcode application target that hosts Swift previews, for the Apple
   * Snapshots wizard. Passed via `--app-target`.
   */
  appTarget?: string | undefined;

  /**
   * Hosted XCTest target to configure, for the Apple Snapshots wizard.
   * Passed via `--hosted-test-target`.
   */
  hostedTestTarget?: string | undefined;

  /**
   * Fail instead of prompting when a choice is ambiguous. Only the Apple
   * Snapshots wizard reads it. Passed via `--non-interactive`.
   */
  nonInteractive?: boolean | undefined;
};

export interface Feature {
  id: string;
  prompt: string;
  enabledHint?: string | undefined;
  disabledHint?: string | undefined;
}
