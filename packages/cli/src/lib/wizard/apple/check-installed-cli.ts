/**
 * Check that the debug-file upload build phase can find `sentry`.
 *
 * The user runs the wizard through `sentry`, so the CLI is installed, but an
 * Xcode build phase doesn't see the user's shell `PATH`: it searches the
 * system directories plus the ones the generated script adds (see
 * {@link xcodeSearchDirs}). When `sentry` is in none of them, the wizard
 * prints how to install it where Xcode finds it.
 */

import { homedir } from "node:os";
import path from "node:path";

import { whichSync } from "../../which.js";
import { Sentry } from "../telemetry.js";
import { clack } from "../utils/clack/prompts.js";
import { debug } from "../utils/debug.js";

/**
 * The directories a Sentry build phase searches for `sentry`: the
 * standalone installer's (`~/.local/bin`, `~/bin`), Homebrew's, and the
 * system ones in Xcode's default `PATH`.
 */
export function xcodeSearchDirs(home: string = homedir()): string[] {
  return [
    path.join(home, ".local", "bin"),
    path.join(home, "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
}

/** How to install the Sentry CLI where an Xcode build phase finds it. */
export const SENTRY_CLI_INSTALL_INSTRUCTIONS = [
  "Install the Sentry CLI with one of:",
  "  brew install getsentry/tools/sentry",
  "  curl https://cli.sentry.dev/install -fsS | bash",
  "  npm install -g sentry",
].join("\n");

/** Default warning when `sentry` is out of the build phase's reach. */
const DEFAULT_WARNING =
  "Xcode build phases can't find the `sentry` CLI, so your builds won't upload debug symbols to Sentry.";

/**
 * Whether an Xcode build phase finds `sentry`, warning with install
 * instructions when it doesn't.
 *
 * @param warning - Explains what doesn't work without `sentry`.
 * @returns The path of the `sentry` the build phase would run, if any.
 */
export function checkInstalledCLI(
  warning: string = DEFAULT_WARNING,
): string | undefined {
  debug("Checking whether Xcode build phases can find sentry");
  const searchDirs = xcodeSearchDirs();
  const cliPath =
    whichSync("sentry", { PATH: searchDirs.join(path.delimiter) }) ?? undefined;
  Sentry.setTag("has-cli", cliPath !== undefined);
  if (cliPath) {
    debug(`Xcode build phases will run ${cliPath}`);
    return cliPath;
  }

  clack.log.warn(
    [
      warning,
      "Xcode doesn't use your shell's PATH: it looks in",
      `${searchDirs.join(", ")}.`,
      "",
      SENTRY_CLI_INSTALL_INSTRUCTIONS,
    ].join("\n"),
  );
  return undefined;
}
