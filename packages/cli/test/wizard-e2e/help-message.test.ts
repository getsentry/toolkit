import { describe, expect, it } from "vitest";
import { runCli } from "./utils.js";

describe("sentry wizard --help", () => {
  it("prints the up to date help", () => {
    const { exitCode, stdout } = runCli(["wizard", "--help"]);

    expect(exitCode).toBe(0);
    expect(stdout).toMatchInlineSnapshot(`
      "USAGE
        sentry wizard [<org>/<project>] [<integration>]
        sentry wizard --help

      Set up Sentry in the project in the current directory. The wizard asks you a few questions, installs the Sentry SDK for your framework, writes its configuration, and sets up source map or debug file uploads.

      It logs in with your \`sentry auth login\` account (or starts a login) on the Sentry instance the rest of the CLI uses, and lets you pick or create the Sentry project to send data to. Pass \`<org>/<project>\` first to skip those questions, or \`<org>/\` to pick only the project. Pass an integration, such as \`nextjs\`, to skip the integration picker. Integrations: reactNative, flutter, ios, appleSnapshots, angular, android, nextjs, nuxt, remix, reactRouter, sveltekit, cloudflare, sourcemaps.

      An integration id is never read as a project or org, and a single bare word is always read as an integration. To name a project or org, write it with a \`/\`: \`my-org/my-project\`, \`my-org/\`, or \`/my-project\` (for a project spelled like an integration, \`my-org/nextjs\`).

      Set \`SENTRY_SPOTLIGHT=1\` to set up Spotlight for local development instead, without a Sentry account or login. Use the global \`--verbose\` flag for the wizard's debug output.

      The wizard changes files in your project. To have a coding agent set up Sentry instead, run \`sentry init\`, which prints the agent's setup guide and changes nothing.

      Examples:
        sentry wizard # Pick an integration and a project, then set it up
        sentry wizard nextjs # Set up Next.js, picking the project
        sentry wizard my-org/my-project nextjs # Set up Next.js for a known org and project
        SENTRY_SPOTLIGHT=1 sentry wizard nextjs # Set up Next.js for Spotlight, without a Sentry account

      FLAGS
        -f [--force]  Change a project with uncommitted changes without asking, and install the SDK even when the package manager's checks fail [default = false]
        -h  --help    Print help information and exit
            --        All subsequent inputs should be interpreted as arguments

      ARGUMENTS
        org/project-or-integration...  <org>/<project> to set up (skips the project picker), then the integration (skips the integration picker)
      "
    `);
  });

  // Flags of `npx @sentry/wizard` that `sentry wizard` dropped. `--org` and
  // `--project` still work: every CLI command takes them as hidden flags that
  // set SENTRY_ORG and SENTRY_PROJECT.
  it.each([
    ["--signup"],
    ["-s"],
    ["--promo-code", "CODE"],
    ["--coming-from", "partner"],
    ["-i", "nextjs"],
    ["--url", "https://sentry.example.com"],
    ["--saas"],
    ["--spotlight"],
    ["--force-install"],
    ["--ignore-git-changes"],
    ["--disable-telemetry"],
    ["--debug"],
  ])("rejects the removed flag %s", (...flag) => {
    const { exitCode, stderr } = runCli(["wizard", ...flag]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/^No (flag|alias) registered for /);
  });
});
