/**
 * Options of the iOS and Apple Snapshots wizards.
 */

import { type WizardOptions } from "../utils/types.js";

export interface AppleWizardOptions extends WizardOptions {
  /** Directory to look for the Xcode project in; the current directory when unset. */
  projectDir?: string | undefined;
}

export interface AppleSnapshotsWizardOptions extends AppleWizardOptions {
  /** Fail with the choices instead of prompting, such as when stdin is not a terminal. */
  nonInteractive: boolean;
}
