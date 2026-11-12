import type { SentryContext } from "../../context.js";
import { buildCommand } from "../../lib/command.js";
import {
  ACCOUNT_SERVER_TARGET,
  completingParser,
} from "../../lib/completion-target.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { bootstrapAuthentication } from "../../lib/setup-code.js";
import type { BootstrapResult } from "../../output-schemas/auth.js";
import { BootstrapResultSchema } from "../../generated/output-schemas/auth.js";
import { applyLoginUrl, formatLoginResult, parseLoginUrl } from "./login.js";

/** Authenticate without opening a browser using a private, one-use setup code. */
export const bootstrapCommand = buildCommand({
  auth: false,
  skipRcUrlCheck: true,
  docs: {
    brief: "Authenticate using a one-time setup code",
    fullDescription:
      "Redeem SENTRY_SETUP_CODE for OAuth credentials without opening a browser.\n\n" +
      "The code is short-lived and can be redeemed only once. Get a new code from Sentry if it has expired or already been used.\n" +
      "Use --force to replace an existing stored login.",
  },
  parameters: {
    flags: {
      force: {
        kind: "boolean",
        brief: "Replace the stored login",
        default: false,
      },
      url: {
        kind: "parsed",
        parse: completingParser(ACCOUNT_SERVER_TARGET, parseLoginUrl),
        brief: "Explicit issuing Sentry instance URL",
        optional: true,
      },
    },
  },
  output: {
    human: (result: BootstrapResult) => formatLoginResult(result),
    schema: BootstrapResultSchema,
  },
  async *func(this: SentryContext, flags: { force: boolean; url?: string }) {
    applyLoginUrl(flags.url);
    yield new CommandOutput(await bootstrapAuthentication(flags));
  },
});
