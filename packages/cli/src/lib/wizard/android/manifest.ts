/**
 * Reads and patches the app's `AndroidManifest.xml`: adds the Sentry SDK's
 * `<meta-data>` options and finds the main activity.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import chalk from "chalk";
import { reportCliError } from "../../error-reporting.js";
import { debug } from "../utils/debug.js";
import { clack } from "../utils/clack/prompts.js";
import { manifest } from "./templates.js";
import { childElements, parseXml, type XmlElement } from "./xml.js";

/**
 * Looks for the closing </application> tag in the manifest and adds the Sentry config after it.
 *
 * For example:
 * ```xml
 * <manifest xmlns:android="http://schemas.android.com/apk/res/android"
 *   xmlns:tools="http://schemas.android.com/tools">
 *
 *   <application>
 *     ...
 *     // this is what we add and more
 *     <meta-data android:name="io.sentry.dsn" android:value="__dsn__" />
 *   </application> <!-- we are looking for this one
 * </manifest>
 * ```
 *
 * @param manifestFile the path to the main AndroidManifest.xml file
 * @param dsn
 * @returns true if successfully patched the manifest, false otherwise
 */
export function addManifestSnippet(
  manifestFile: string,
  dsn: string,
  enableLogs: boolean,
): boolean {
  if (!existsSync(manifestFile)) {
    clack.log.warn("AndroidManifest.xml not found.");
    reportCliError(new Error("No AndroidManifest file"));
    return false;
  }

  const manifestContent = readFileSync(manifestFile, "utf8");

  if (/android:name="io\.sentry[^"]*"/i.test(manifestContent)) {
    // sentry is already configured
    clack.log.success(chalk.greenBright("Sentry SDK is already configured."));
    return true;
  }

  const applicationMatch = /<\/application>/i.exec(manifestContent);
  if (!applicationMatch) {
    clack.log.warn("<application> tag not found within the manifest.");
    reportCliError(new Error("No <application> tag"));
    return false;
  }

  const insertionIndex = applicationMatch.index;
  const newContent =
    manifestContent.slice(0, insertionIndex) +
    manifest(dsn, enableLogs) +
    manifestContent.slice(insertionIndex);
  writeFileSync(manifestFile, newContent, "utf8");

  clack.log.success(
    chalk.greenBright(
      `Updated ${chalk.bold(
        "AndroidManifest.xml",
      )} with the Sentry SDK configuration.`,
    ),
  );

  return true;
}

/**
 * There might be multiple <activity> in the manifest, as well as multiple <activity-alias> with category LAUNCHER,
 * but only one main activity with action MAIN. We are looking for this one by parsing xml and walking it.
 *
 * In addition, older Android versions required to specify the packag name in the manifest,
 * while the new ones - in the Gradle config. So we are just sanity checking if the package name
 * is in the manifest and returning it as well.
 *
 * For example:
 *
 * ```xml
 * <manifest xmlns:android="http://schemas.android.com/apk/res/android"
 *   xmlns:tools="http://schemas.android.com/tools"
 *   package="com.example.sample">
 *
 *   <application>
 *     <activity
 *       android:name="ui.MainActivity"
 *       ...other props>
 *        <intent-filter>
 *          <action android:name="android.intent.action.MAIN" /> <!-- we are looking for this one
 *
 *          <category android:name="android.intent.category.LAUNCHER" />
 *        </intent-filter>
 *     </activity>
 *   </application>
 * </manifest>
 * ```
 *
 * @param manifestFile path to the AndroidManifest.xml file
 * @returns package name (if available in the manifest) + the main activity name
 */
export function getMainActivity(manifestFile: string): {
  packageName?: string | undefined;
  activityName?: string | undefined;
} {
  if (!existsSync(manifestFile)) {
    clack.log.warn("AndroidManifest.xml not found.");
    reportCliError(new Error("No AndroidManifest file"));
    return {};
  }

  const manifestContent = readFileSync(manifestFile, "utf8");
  let root: XmlElement;
  try {
    root = parseXml(manifestContent);
  } catch (error) {
    // The caller asks the user to verify the setup by hand.
    debug(error);
    clack.log.warn("Could not parse AndroidManifest.xml.");
    return {};
  }

  const manifestElement = root.name === "manifest" ? root : undefined;
  const [application] = childElements(manifestElement, "application");
  const activities = childElements(application, "activity");
  const packageName = manifestElement?.attributes["package"];

  if (activities.length === 0) {
    clack.log.warn("No activity found in AndroidManifest.");
    reportCliError(new Error("No Activity"));
    return {};
  }

  const mainActivity = activities.find((a) => isMainActivity(a));

  if (!mainActivity) {
    clack.log.warn("No main activity found in AndroidManifest.");
    reportCliError(new Error("No Main Activity"));
    return {};
  }

  const activityName = mainActivity.attributes["android:name"];
  return { packageName, activityName };
}

/** Whether one of the activity's intent filters has the MAIN action. */
function isMainActivity(activity: XmlElement): boolean {
  return childElements(activity, "intent-filter").some((intentFilter) =>
    childElements(intentFilter, "action").some(
      (action) =>
        action.attributes["android:name"] === "android.intent.action.MAIN",
    ),
  );
}
