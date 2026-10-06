/**
 * `sentry send-envelope` — Deprecated. Suggests `sentry event send --raw`.
 *
 * Kept as a hidden backward-compat alias that prints a deprecation notice
 * and forwards to `sentry event send --raw`.
 */

import type { SentryContext } from "../context.js";
import { buildCommand } from "../lib/command.js";
import { CliError, EXIT } from "../lib/errors.js";

export const sendEnvelopeCommand = buildCommand({
  docs: {
    brief: "Send a Sentry envelope file (deprecated)",
    fullDescription:
      "This command has been replaced by `sentry event send --raw <file>`.\n\n" +
      "Use `sentry event send --raw ./captured.envelope` instead.",
  },
  auth: false,
  skipRcUrlCheck: true,
  output: {
    human: () => "",
  },
  parameters: {
    positional: {
      kind: "array",
      parameter: {
        brief: "Path(s) to envelope file(s)",
        parse: String,
        optional: true,
      },
    },
    flags: {
      dsn: {
        kind: "parsed",
        parse: String,
        brief: "DSN",
        optional: true,
      },
      raw: {
        kind: "boolean",
        brief: "Raw mode",
        default: false,
        optional: true,
      },
    },
  },
  // biome-ignore lint/correctness/useYield lint/suspicious/useAwait: deprecation shim — throws before yielding
  async *func(
    this: SentryContext,
    _flags: { dsn?: string; raw?: boolean },
    ...files: string[]
  ) {
    const fileArgs = files.length > 0 ? ` ${files.join(" ")}` : " <file>";
    throw new CliError(
      "`sentry send-envelope` has been removed.\n" +
        `Use: sentry event send --raw${fileArgs}`,
      EXIT.GENERAL
    );
  },
});
