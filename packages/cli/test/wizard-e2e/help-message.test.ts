import { describe, expect, it } from "vitest";
import { runCli } from "./utils.js";

describe("sentry wizard --help", () => {
  it("prints the up to date help", () => {
    const { exitCode, stdout } = runCli(["wizard", "--help"]);

    expect(exitCode).toBe(0);
    expect(stdout).toMatchInlineSnapshot(`
      "USAGE
        sentry wizard [--integration reactNative|flutter|ios|appleSnapshots|angular|android|nextjs|nuxt|remix|reactRouter|sveltekit|cloudflare|sourcemaps] [--url url] [--org org] [--project project] [--saas] [--spotlight] [--force-install] [--ignore-git-changes] [--disable-telemetry] [--debug]
        sentry wizard --help

      Set up Sentry in the project in the current directory. The wizard asks you a few questions, installs the Sentry SDK for your framework, writes its configuration, and sets up source map or debug file uploads. It logs in with your \`sentry auth login\` account (or starts a login), and lets you pick or create the Sentry project to send data to.

      Pass \`-i\` to skip the integration picker. It takes the same integrations and flags as \`npx @sentry/wizard\`, except the sign-up flags \`--signup\`, \`--promo-code\` and \`--coming-from\`, which fail: sign up at https://sentry.io/signup/ first.

      The wizard changes files in your project. To have a coding agent set up Sentry instead, run \`sentry init\`, which prints the agent's setup guide and changes nothing.

      Examples:
        sentry wizard # Pick an integration and set it up
        sentry wizard -i nextjs --saas --org my-org --project my-project # Set up Next.js for a known org and project on sentry.io
        sentry wizard -i nextjs --spotlight # Set up Next.js for Spotlight, without a Sentry account

      FLAGS
        -i [--integration]         Integration to set up (skips the picker)                         [reactNative|flutter|ios|appleSnapshots|angular|android|nextjs|nuxt|remix|reactRouter|sveltekit|cloudflare|sourcemaps]
        -u [--url]                 URL of your self-hosted Sentry instance
           [--org]                 Slug of the Sentry organization to use
           [--project]             Slug of the Sentry project to use
           [--saas]                Use Sentry SaaS (sentry.io) without asking                       [default = false]
           [--spotlight]           Set up Spotlight for local development, without a Sentry account [default = false]
           [--force-install]       Install the SDK even when the package manager's checks fail      [default = false]
           [--ignore-git-changes]  Don't ask before changing a project with uncommitted changes     [default = false]
           [--disable-telemetry]   Don't send telemetry about this run to Sentry                    [default = false]
           [--debug]               Print the wizard's debug output                                  [default = false]
        -h  --help                 Print help information and exit
            --                     All subsequent inputs should be interpreted as arguments
      "
    `);
  });

  it.each([
    ["--signup"],
    ["-s"],
    ["--promo-code", "CODE"],
    ["--coming-from", "partner"],
  ])("rejects the removed sign-up flag %s", (...flag) => {
    const { exitCode, stderr } = runCli(["wizard", ...flag]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("no longer supported");
  });
});
