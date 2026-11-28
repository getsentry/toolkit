/**
 * Patch a React Native iOS project's build phases: run the bundle phase
 * through the SDK's `sentry-xcode.sh` and add a debug-file upload phase.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { debug } from "../utils/debug.js";
import { reportCliError } from "../../error-reporting.js";
import { clack } from "../utils/clack/prompts.js";
import chalk from "chalk";
import {
  makeCodeSnippet,
  showCopyPasteInstructions,
} from "../utils/clack/index.js";
import type { Project } from "xcode";

type BuildPhase = { shellScript: string };
type BuildPhaseMap = Record<string, BuildPhase>;

export function getValidExistingBuildPhases(
  xcodeProject: Project,
): BuildPhaseMap {
  const map: BuildPhaseMap = {};
  const raw = xcodeProject.hash.project.objects.PBXShellScriptBuildPhase ?? {};
  for (const [key, val] of Object.entries(raw)) {
    // Skip the `<id>_comment` entries, and phases without a script.
    if (typeof val !== "string" && typeof val.shellScript === "string") {
      map[key] = val as BuildPhase;
    }
  }

  return map;
}

export class ErrorPatchSnippet {
  snippet: string;

  constructor(snippet: string) {
    this.snippet = snippet;
  }
}

export async function patchBundlePhase(
  bundlePhase: BuildPhase | undefined,
  patch: (script: string) => string | ErrorPatchSnippet,
) {
  if (!bundlePhase) {
    clack.log.warn(
      `Could not find ${chalk.cyan(
        "Bundle React Native code and images",
      )} build phase.`,
    );
    return;
  }

  const bundlePhaseIncludesSentry = doesBundlePhaseIncludeSentry(bundlePhase);
  if (bundlePhaseIncludesSentry) {
    clack.log.warn(
      `Build phase ${chalk.cyan(
        "Bundle React Native code and images",
      )} already includes Sentry.`,
    );
    return;
  }

  const script: string = JSON.parse(bundlePhase.shellScript);
  const patchedScript = patch(script);
  if (patchedScript instanceof ErrorPatchSnippet) {
    await showCopyPasteInstructions({
      filename: "Xcode project",
      codeSnippet: patchedScript.snippet,
      hint: `Apply in the 'Bundle React Native code and images' build phase`,
    });
    return;
  }
  bundlePhase.shellScript = JSON.stringify(patchedScript);
  clack.log.success(
    `Patched Build phase ${chalk.cyan("Bundle React Native code and images")}.`,
  );
}

export function findBundlePhase(buildPhases: BuildPhaseMap) {
  return Object.values(buildPhases).find((buildPhase) =>
    buildPhase.shellScript.match(/\/scripts\/react-native-xcode\.sh/i),
  );
}

export function doesBundlePhaseIncludeSentry(buildPhase: BuildPhase) {
  const containsSentryCliRNCommand = !!buildPhase.shellScript.match(
    /\bsentry(?:-cli)?\s+react-native\s+xcode\b/i,
  );
  const containsBundledScript =
    buildPhase.shellScript.includes("sentry-xcode.sh");
  return containsSentryCliRNCommand || containsBundledScript;
}

export function addSentryWithBundledScriptsToBundleShellScript(
  script: string,
): string | ErrorPatchSnippet {
  let patchedScript = script;
  const isLikelyPlainReactNativeScript = script.includes("$REACT_NATIVE_XCODE");
  if (isLikelyPlainReactNativeScript) {
    patchedScript = script
      .replaceAll("REACT_NATIVE_XCODE", "SENTRY_XCODE")
      .replace(
        "react-native/scripts/react-native-xcode.sh",
        "@sentry/react-native/scripts/sentry-xcode.sh",
      )
      // that might be needed for older versions of React Native (< 0.81)
      .replace(
        "$REACT_NATIVE_PATH/scripts/react-native-xcode.sh",
        "$REACT_NATIVE_PATH/../@sentry/react-native/scripts/sentry-xcode.sh",
      );
  }

  const isLikelyExpoScript = script.includes("expo");
  if (isLikelyExpoScript) {
    const SENTRY_REACT_NATIVE_XCODE_PATH =
      "`\"$NODE_BINARY\" --print \"require('path').dirname(require.resolve('@sentry/react-native/package.json')) + '/scripts/sentry-xcode.sh'\"`";
    patchedScript = script.replace(
      /^.*?(packager|scripts)\/react-native-xcode\.sh\s*(\\'\\\\")?/m,
      (match: string) => `/bin/sh ${SENTRY_REACT_NATIVE_XCODE_PATH} ${match}`,
    );
  }

  if (patchedScript === script) {
    // No changes were made
    clack.log.error(
      `Failed to patch ${chalk.cyan(
        "Bundle React Native code and images",
      )} build phase.`,
    );
    reportCliError(
      new Error(
        `Failed to patch 'Bundle React Native code and images' build phase.`,
      ),
    );
    if (isLikelyExpoScript) {
      return new ErrorPatchSnippet(
        makeCodeSnippet(true, (unchanged, plus, _minus) => {
          return unchanged(
            `${plus(
              `/bin/sh \`"$NODE_BINARY" --print "require('path').dirname(require.resolve('@sentry/react-native/package.json')) + '/scripts/sentry-xcode.sh'"\``,
            )} \`"$NODE_BINARY" --print "require('path').dirname(require.resolve('react-native/package.json')) + '/scripts/react-native-xcode.sh'"\``,
          );
        }),
      );
    }
    // plain react-native
    return new ErrorPatchSnippet(
      makeCodeSnippet(true, (unchanged, plus, _minus) => {
        return unchanged(`WITH_ENVIRONMENT="$REACT_NATIVE_PATH/scripts/xcode/with-environment.sh"
REACT_NATIVE_XCODE="$REACT_NATIVE_PATH/scripts/react-native-xcode.sh"

/bin/sh -c "$WITH_ENVIRONMENT ${plus(
          `\\"/bin/sh ../node_modules/@sentry/react-native/scripts/sentry-xcode.sh `,
        )}$REACT_NATIVE_XCODE${plus(`\\"`)}"
`);
      }),
    );
  }

  return patchedScript;
}

export function addDebugFilesUploadPhaseWithBundledScripts(
  xcodeProject: Project,
  { debugFilesUploadPhaseExists }: { debugFilesUploadPhaseExists: boolean },
) {
  if (debugFilesUploadPhaseExists) {
    clack.log.warn(
      `Build phase ${chalk.cyan(
        "Upload Debug Symbols to Sentry",
      )} already exists.`,
    );
    return;
  }

  xcodeProject.addBuildPhase(
    [],
    "PBXShellScriptBuildPhase",
    "Upload Debug Symbols to Sentry",
    null,
    {
      shellPath: "/bin/sh",
      shellScript: `/bin/sh ../node_modules/@sentry/react-native/scripts/sentry-xcode-debug-files.sh`,
    },
  );
  clack.log.success(
    `Added Build phase ${chalk.cyan("Upload Debug Symbols to Sentry")}.`,
  );
}

export function findDebugFilesUploadPhase(
  buildPhasesMap: Record<string, BuildPhase>,
): [key: string, buildPhase: BuildPhase] | undefined {
  return Object.entries(buildPhasesMap).find(([_, buildPhase]) => {
    const containsCliDebugUpload =
      typeof buildPhase !== "string" &&
      !!buildPhase.shellScript.match(
        /\bsentry-cli\s+(?:upload-dsym|debug-files\s+upload)\b|\bsentry\s+debug-files\s+upload\b/,
      );
    const containsBundledDebugUpload =
      typeof buildPhase !== "string" &&
      buildPhase.shellScript.includes("sentry-xcode-debug-files.sh");
    return containsCliDebugUpload || containsBundledDebugUpload;
  });
}

// React Native SwiftPM autolinking adds a local package at this path.
export function usesSwiftPMAutolinking(xcodeProjectPath: string): boolean {
  try {
    return /relativePath = "?build\/generated\/autolinking"?;/.test(
      readFileSync(xcodeProjectPath, "utf-8"),
    );
  } catch (error) {
    // An unreadable project is treated as not using SwiftPM autolinking.
    debug(error);
    return false;
  }
}

export function writeXcodeProject(
  xcodeProjectPath: string,
  xcodeProject: Project,
) {
  try {
    const newContent = xcodeProject.writeSync();
    const currentContent = readFileSync(xcodeProjectPath, "utf-8");
    if (newContent === currentContent) {
      return;
    }

    writeFileSync(xcodeProjectPath, newContent, "utf-8");
    clack.log.success(
      chalk.green(
        `Xcode project ${chalk.cyan(xcodeProjectPath)} changes saved.`,
      ),
    );
  } catch (error) {
    clack.log.error(
      `Error while writing Xcode project ${chalk.cyan(xcodeProjectPath)}`,
    );
    reportCliError(new Error("Error while writing Xcode project"));
  }
}
