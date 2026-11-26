/**
 * Pick and run a setup wizard for `sentry wizard`.
 *
 * Each integration's flow lives in its own directory and loads with a
 * dynamic `import()`, so a run loads only the flow it needs (and its heavy
 * dependencies, such as magicast).
 */

import { ValidationError } from "../errors.js";
import { abortIfCancelled } from "./utils/clack/index.js";
import { clack } from "./utils/clack/prompts.js";
import { enableDebugLogs } from "./utils/debug.js";
import type { WizardOptions } from "./utils/types.js";
import { CLI_VERSION } from "../constants.js";

/**
 * The integrations `sentry wizard -i` accepts, in the order the picker lists
 * them. The ids are the ones `@sentry/wizard -i` took.
 */
export const WIZARD_INTEGRATIONS = [
  { id: "reactNative", label: "React Native" },
  { id: "flutter", label: "Flutter" },
  { id: "ios", label: "iOS" },
  { id: "appleSnapshots", label: "Apple Snapshots" },
  { id: "angular", label: "Angular" },
  { id: "android", label: "Android" },
  { id: "nextjs", label: "Next.js" },
  { id: "nuxt", label: "Nuxt" },
  { id: "remix", label: "Remix" },
  { id: "reactRouter", label: "React Router" },
  { id: "sveltekit", label: "SvelteKit" },
  { id: "cloudflare", label: "Cloudflare" },
  { id: "sourcemaps", label: "Configure Source Maps Upload" },
] as const;

/** An integration id `sentry wizard -i` accepts. */
export type WizardIntegration = (typeof WIZARD_INTEGRATIONS)[number]["id"];

/**
 * Every value `-i` accepts. The Cordova and Electron wizards of
 * `@sentry/wizard` were retired; their setup guides are in the Sentry docs.
 */
export const INTEGRATION_IDS: readonly WizardIntegration[] =
  WIZARD_INTEGRATIONS.map((integration) => integration.id);

/** Runs the wizard of one integration. */
type WizardRunner = (options: WizardOptions) => Promise<void>;

/**
 * The flow of each integration. Integrations without one are still being
 * moved over from sentry-wizard.
 */
const WIZARD_RUNNERS: Partial<Record<WizardIntegration, WizardRunner>> = {
  nextjs: async (options) => {
    const { runNextjsWizard } = await import("./nextjs/nextjs-wizard.js");
    await runNextjsWizard(options);
  },
  ios: async (options) => {
    const { runAppleWizard } = await import("./apple/apple-wizard.js");
    await runAppleWizard({ ...options, projectDir: options.xcodeProjectDir });
  },
  appleSnapshots: async (options) => {
    const { runAppleSnapshotsWizard } =
      await import("./apple/snapshots/apple-snapshots-wizard.js");
    await runAppleSnapshotsWizard({
      ...options,
      projectDir: options.xcodeProjectDir,
      appTarget: options.appTarget,
      hostedTestTarget: options.hostedTestTarget,
      nonInteractive: options.nonInteractive ?? false,
    });
  },
  reactNative: async (options) => {
    const { runReactNativeWizard } =
      await import("./react-native/react-native-wizard.js");
    await runReactNativeWizard(options);
  },
};

/** What `sentry wizard` passes to {@link runWizard}. */
export type RunWizardArgs = {
  /** `-i`: the integration to set up; prompts for one when unset. */
  integration?: string | undefined;
  /** `--debug`: print the wizard's debug output. */
  debug: boolean;
  /** The options every wizard flow takes. */
  wizardOptions: WizardOptions;
};

/**
 * Run the wizard of `args.integration`, after asking for one when it is
 * unset.
 *
 * @throws {ValidationError} For an unknown integration, or one that has no
 *   flow in this version yet
 */
export async function runWizard(args: RunWizardArgs): Promise<void> {
  if (args.debug) {
    enableDebugLogs();
  }

  const integration = args.integration
    ? toWizardIntegration(args.integration)
    : await askForIntegration();

  const runner = WIZARD_RUNNERS[integration];
  if (!runner) {
    throw new ValidationError(
      `The ${integration} wizard is not available in this version yet.`,
      "integration",
    );
  }
  await runner(args.wizardOptions);
}

/**
 * `id` as one of {@link WIZARD_INTEGRATIONS}. `-i` already checks its
 * value; `SENTRY_WIZARD_INTEGRATION` is checked here.
 *
 * @throws {ValidationError} When `id` names no integration
 */
function toWizardIntegration(id: string): WizardIntegration {
  const match = WIZARD_INTEGRATIONS.find(
    (integration) => integration.id === id,
  );
  if (!match) {
    throw new ValidationError(
      `Unknown integration "${id}". Pick one of: ${INTEGRATION_IDS.join(", ")}.`,
      "integration",
    );
  }
  return match.id;
}

/** Ask which integration to set up, out of the ones that have a flow. */
async function askForIntegration(): Promise<WizardIntegration> {
  clack.intro(`Sentry Wizard ${CLI_VERSION}`);
  const integration = await abortIfCancelled(
    clack.select<WizardIntegration>({
      message: "What do you want to set up?",
      options: WIZARD_INTEGRATIONS.filter(({ id }) => id in WIZARD_RUNNERS).map(
        ({ id, label }) => ({ value: id, label }),
      ),
    }),
  );
  clack.outro(`Starting ${integration} setup`);
  return integration;
}
