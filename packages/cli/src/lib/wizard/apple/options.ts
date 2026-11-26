/**
 * Options of the iOS and Apple Snapshots wizards.
 */

import { type WizardOptions } from "../utils/types.js";

export interface AppleWizardOptions extends WizardOptions {
  projectDir: string | undefined;
}

export interface AppleSnapshotsWizardOptions extends AppleWizardOptions {
  appTarget?: string | undefined;
  hostedTestTarget?: string | undefined;
  nonInteractive: boolean;
}
