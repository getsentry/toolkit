/**
 * `sentry-mcp auth` for the standalone `@sentry/mcp-server` bundle.
 *
 * Only `login` is built in, so the package can authenticate without the CLI.
 * Account management stays in `sentry auth`, which uses the same session.
 */

import { assertAutoLoginHostTrusted } from "../auto-auth.js";
import { ValidationError } from "../errors.js";
import { runInteractiveLogin } from "../interactive-login.js";

/** Run `sentry-mcp auth [login]`. */
export async function runMcpServerAuth(args: readonly string[]): Promise<void> {
  const [subcommand = "login", ...rest] = args;
  if (subcommand !== "login" || rest.length > 0) {
    throw new ValidationError(
      `\`sentry-mcp auth ${args.join(" ")}\` is not supported. ` +
        `Run \`npx -y sentry auth ${args.join(" ")}\` instead; it uses the same session.`,
    );
  }

  // Never start an OAuth device flow against an unconfirmed self-hosted host.
  assertAutoLoginHostTrusted();

  const result = await runInteractiveLogin();
  if (!result) {
    process.exitCode = 1;
    return;
  }
  const identity = result.user?.email ?? result.user?.username;
  process.stderr.write(
    identity ? `Logged in as ${identity}.\n` : "Logged in.\n",
  );
}
