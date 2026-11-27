/**
 * Write the Sentry auth token to Expo's `.env.local` and keep that file out
 * of git.
 */

import { clack } from "../utils/clack/prompts.js";
import { reportCliError } from "../../error-reporting.js";
import chalk from "chalk";
import fs from "fs";
import { Sentry } from "../telemetry.js";
import { type RNCliSetupConfigContent } from "./react-native-wizard.js";
import { addToGitignore } from "./git.js";

const EXPO_ENV_LOCAL_FILE = ".env.local";

export async function addExpoEnvLocal(
  options: RNCliSetupConfigContent,
): Promise<boolean> {
  const newContent = `#DO NOT COMMIT THIS\nSENTRY_AUTH_TOKEN=${options.authToken}\n`;

  const added = await addToGitignore(EXPO_ENV_LOCAL_FILE);
  if (added) {
    Sentry.setTag("expo-env-local", "added-to-gitignore");
    clack.log.success(
      `Added ${chalk.cyan(EXPO_ENV_LOCAL_FILE)} to .gitignore.`,
    );
  } else {
    Sentry.setTag("expo-env-local", "add-to-gitignore-error");
    clack.log.error(
      `Could not add ${chalk.cyan(
        EXPO_ENV_LOCAL_FILE,
      )} to .gitignore, please add it to not commit your auth key.`,
    );
    reportCliError(
      new Error(`Could not add ${EXPO_ENV_LOCAL_FILE} to .gitignore`),
    );
  }

  if (!fs.existsSync(EXPO_ENV_LOCAL_FILE)) {
    try {
      await fs.promises.writeFile(EXPO_ENV_LOCAL_FILE, newContent);
      Sentry.setTag("expo-env-local", "written");
      clack.log.success(`Written ${chalk.cyan(EXPO_ENV_LOCAL_FILE)}.`);
      return true;
    } catch (error) {
      Sentry.setTag("expo-env-local", "write-error");
      clack.log.error(`Unable to write ${chalk.cyan(EXPO_ENV_LOCAL_FILE)}.`);
      reportCliError(new Error(`Unable to write ${EXPO_ENV_LOCAL_FILE}.`));
      return false;
    }
  }

  Sentry.setTag("expo-env-local", "exists");
  clack.log.info(`Updating existing ${chalk.cyan(EXPO_ENV_LOCAL_FILE)}.`);

  try {
    await fs.promises.appendFile(EXPO_ENV_LOCAL_FILE, newContent);
    Sentry.setTag("expo-env-local", "updated");
    clack.log.success(`Updated ${chalk.cyan(EXPO_ENV_LOCAL_FILE)}.`);
    return true;
  } catch (error) {
    Sentry.setTag("expo-env-local", "update-error");
    clack.log.error(`Unable to update ${chalk.cyan(EXPO_ENV_LOCAL_FILE)}.`);
    reportCliError(new Error(`Unable to update ${EXPO_ENV_LOCAL_FILE}.`));
    return false;
  }
}
