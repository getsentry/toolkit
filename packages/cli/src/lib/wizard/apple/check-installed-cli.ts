/**
 * Check that the debug-file upload build phase can find `sentry`.
 *
 * The user runs the wizard through `sentry`, so the CLI is installed, but an
 * Xcode build phase doesn't see the user's shell `PATH`: it searches the
 * system directories plus the ones the generated script adds (see
 * {@link xcodeSearchDirs}). Without `sentry` there, the build phase runs it
 * with `npx`, so the wizard only notes that builds would be faster with the
 * CLI installed. With neither, it warns and prints how to install it where
 * Xcode finds it.
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

/** Commands that install the Sentry CLI where an Xcode build phase finds it. */
const SENTRY_CLI_INSTALL_COMMANDS = [
  "  brew install getsentry/tools/sentry",
  "  curl https://cli.sentry.dev/install -fsS | bash",
  "  npm install -g sentry",
];

/** Default warning when `sentry` is out of the build phase's reach. */
const DEFAULT_WARNING =
  "Xcode build phases can't find the `sentry` CLI, so your builds won't upload debug symbols to Sentry.";

/**
 * Whether an Xcode build phase finds `sentry`, or `npx` to run it with,
 * warning with install instructions when it finds neither.
 *
 * @param warning - Explains what doesn't work without `sentry`.
 * @returns The path of the `sentry` or `npx` the build phase would run, if any.
 */
export function checkInstalledCLI(
  warning: string = DEFAULT_WARNING,
): string | undefined {
  debug("Checking whether Xcode build phases can find sentry");
  const searchDirs = xcodeSearchDirs();
  const searchPath = { PATH: searchDirs.join(path.delimiter) };
  const cliPath = whichSync("sentry", searchPath) ?? undefined;
  Sentry.setTag("has-cli", cliPath !== undefined);
  if (cliPath) {
    debug(`Xcode build phases will run ${cliPath}`);
    return cliPath;
  }

  const npxPath = whichSync("npx", searchPath) ?? undefined;
  if (npxPath) {
    debug(`Xcode build phases will run the Sentry CLI with ${npxPath}`);
    clack.log.info(
      [
        "Xcode build phases will run the Sentry CLI with `npx sentry`, which downloads it on the first build.",
        "For faster builds, install it with one of:",
        ...SENTRY_CLI_INSTALL_COMMANDS,
      ].join("\n"),
    );
    return npxPath;
  }

  clack.log.warn(
    [
      warning,
      "Xcode doesn't use your shell's PATH: it looks in",
      `${searchDirs.join(", ")}.`,
      "",
      "Install the Sentry CLI with one of:",
      ...SENTRY_CLI_INSTALL_COMMANDS,
    ].join("\n"),
  );
  return undefined;
}
