/**
 * Turn a validated call into CLI arguments for the SDK's `run()`.
 *
 * `run()` parses them with the command's own Stricli parsers, the same as a
 * terminal invocation, so flag values reach the handler parsed (`--period 7d`
 * becomes a time range) and positionals go through their parsers too.
 */

import type { CommandCall } from "./types";

type FlagValue = CommandCall["flags"][string];

/**
 * `--name=value` keeps a value that starts with `-` (`--sort=-age`) from
 * reading as a flag. Stricli does not read the joined form for an empty value
 * or one with a line break, so those are passed as two arguments.
 */
function flagArgs(name: string, value: FlagValue): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => flagArgs(name, item));
  }
  const text = String(value);
  return text === "" || /[\r\n]/.test(text)
    ? [`--${name}`, text]
    : [`--${name}=${text}`];
}

/**
 * The arguments for `call`: the command path, its flags, `--json`, and the
 * positionals after `--`, so a positional that starts with `-` is not read
 * as a flag.
 */
export function toCommandArgs(call: CommandCall): string[] {
  const flags = Object.entries(call.flags).flatMap(([name, value]) => {
    if (typeof value === "boolean") {
      return [`--${name}=${value}`];
    }
    return flagArgs(name, value);
  });
  const positional =
    call.positional.length > 0 ? ["--", ...call.positional] : [];
  return [...call.path, ...flags, "--json", ...positional];
}
