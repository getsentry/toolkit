/**
 * `sentry bash-hook` — Generate a bash script snippet for shell error reporting.
 *
 * Legacy hidden command kept for backward compatibility with the Rust sentry-cli.
 * Outputs a bash script that, when eval'd, sets up ERR/EXIT traps to
 * automatically capture and report shell errors to Sentry.
 *
 * Usage:
 *   eval "$(sentry bash-hook)"
 *
 * The generated script calls back into `sentry bash-hook --send-event`
 * (internal, hidden) when an error occurs, which parses the traceback
 * and sends a BashError event via DSN authentication.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventEnvelope, makeDsn, serializeEnvelope } from "@sentry/core";
import type { SentryContext } from "../context.js";
import { buildBashErrorEvent } from "../lib/bash-hook/traceback.js";
import { buildCommand } from "../lib/command.js";
import { parseKeyValue } from "../lib/envelope/event-builder.js";
import { requireDsn, sendEnvelopeRequest } from "../lib/envelope/transport.js";
import { ValidationError } from "../lib/errors.js";
import { CommandOutput } from "../lib/formatters/output.js";
import { logger } from "../lib/logger.js";
import { shellQuote } from "../lib/utils.js";

const log = logger.withTag("bash-hook");

/**
 * Embedded bash script template for shell error reporting.
 *
 * Inlined at build time to avoid runtime file-system dependencies.
 * Placeholders are substituted in {@link handleScriptOutput} before output.
 */
const BASH_TEMPLATE = `_SENTRY_TRACEBACK_FILE=___SENTRY_TRACEBACK_FILE___
_SENTRY_LOG_FILE=___SENTRY_LOG_FILE___

if [ "\${SENTRY_CLI_NO_EXIT_TRAP-0}" != 1 ]; then
  trap _sentry_exit_trap EXIT
fi
trap _sentry_err_trap ERR

_sentry_shown_traceback=0

_sentry_exit_trap() {
  local _exit_code="$?"
  local _command="\${BASH_COMMAND:-unknown}"
  if [[ $_exit_code != 0 && "\${_sentry_shown_traceback}" != 1 ]]; then
    _sentry_err_trap "$_command" "$_exit_code"
  fi
  rm -f "$_SENTRY_TRACEBACK_FILE" "$_SENTRY_LOG_FILE"
  exit $_exit_code
}

_sentry_err_trap() {
  local _exit_code="$?"
  local _command="\${BASH_COMMAND:-unknown}"
  if [ $# -ge 1 ] && [ "x$1" != x ]; then
    _command="$1"
  fi
  if [ $# -ge 2 ] && [ "x$2" != x ]; then
    _exit_code="$2"
  fi
  _sentry_traceback 1
  echo "@command:\${_command}" >> "$_SENTRY_TRACEBACK_FILE"
  echo "@exit_code:\${_exit_code}" >> "$_SENTRY_TRACEBACK_FILE"

  : >> "$_SENTRY_LOG_FILE"
  export SENTRY_LAST_EVENT=$(___SENTRY_CLI___ bash-hook --send-event --traceback "$_SENTRY_TRACEBACK_FILE"___SENTRY_TAGS______SENTRY_RELEASE___ --log "$_SENTRY_LOG_FILE")
  rm -f "$_SENTRY_TRACEBACK_FILE" "$_SENTRY_LOG_FILE"
}

_sentry_traceback() {
  _sentry_shown_traceback=1
  local -i start=$(( \${1:-0} + 1 ))
  local -i end=\${#BASH_SOURCE[@]}
  local -i i=0
  local -i j=0

  : > "$_SENTRY_TRACEBACK_FILE"
  for ((i=\${start}; i < \${end}; i++)); do
    j=$(( $i - 1 ))
    local function="\${FUNCNAME[$i]}"
    local file="\${BASH_SOURCE[$i]}"
    local line="\${BASH_LINENO[$j]}"
    echo "\${function}:\${file}:\${line}" >> "$_SENTRY_TRACEBACK_FILE"
  done
}

: > "$_SENTRY_LOG_FILE"

if command -v perl >/dev/null; then
  exec \\
    1> >(tee >(perl '-MPOSIX' -ne '$|++; print strftime("%Y-%m-%d %H:%M:%S %z: ", localtime()), "stdout: ", $_;' >> "$_SENTRY_LOG_FILE")) \\
    2> >(tee >(perl '-MPOSIX' -ne '$|++; print strftime("%Y-%m-%d %H:%M:%S %z: ", localtime()), "stderr: ", $_;' >> "$_SENTRY_LOG_FILE") >&2)
else
  exec \\
    1> >(tee >(awk '{ system(""); print strftime("%Y-%m-%d %H:%M:%S %z:"), "stdout:", $0; system(""); }' >> "$_SENTRY_LOG_FILE")) \\
    2> >(tee >(awk '{ system(""); print strftime("%Y-%m-%d %H:%M:%S %z:"), "stderr:", $0; system(""); }' >> "$_SENTRY_LOG_FILE") >&2)
fi
`;

/** Shape of the data yielded for script output mode. */
type BashHookResult = {
  /** The generated bash script snippet. */
  script: string;
};

/** Shape of the data yielded for send-event mode. */
type SendEventResult = {
  /** The event ID returned after sending. */
  eventId: string;
};

function formatBashHookHuman(result: BashHookResult | SendEventResult): string {
  if ("script" in result) {
    return result.script;
  }
  return result.eventId;
}

/** Flags for the bash-hook command. */
type BashHookFlags = {
  readonly "no-exit": boolean;
  readonly "no-environ": boolean;
  readonly "allow-xcode-infoplist-preprocessing": boolean;
  readonly cli?: string;
  readonly tag?: string[];
  readonly release?: string;
  readonly "send-event": boolean;
  readonly traceback?: string;
  readonly log?: string;
  readonly dsn?: string;
};

/**
 * Handle the --send-event internal mode: parse traceback, build event, send via DSN.
 */
async function handleSendEvent(flags: BashHookFlags): Promise<SendEventResult> {
  if (!flags.traceback) {
    throw new ValidationError(
      "--send-event requires --traceback <path>",
      "traceback"
    );
  }
  if (!flags.log) {
    throw new ValidationError("--send-event requires --log <path>", "log");
  }

  // Parse tags from KEY:VALUE pairs
  const tags: Record<string, string> = {};
  if (flags.tag) {
    for (const pair of flags.tag) {
      const [key, value] = parseKeyValue(pair);
      tags[key] = value;
    }
  }

  const event = await buildBashErrorEvent({
    tracebackPath: flags.traceback,
    logPath: flags.log,
    tags,
    release: flags.release,
  });

  // Send via DSN
  const dsn = requireDsn(flags);
  let dsnComponents: ReturnType<typeof makeDsn>;
  try {
    dsnComponents = makeDsn(dsn);
  } catch (err) {
    log.debug("makeDsn threw for DSN input", err);
    dsnComponents = undefined;
  }
  if (!dsnComponents) {
    throw new ValidationError(`Invalid DSN: ${dsn}`, "dsn");
  }

  const envelope = createEventEnvelope(event, dsnComponents);
  const body = serializeEnvelope(envelope);
  await sendEnvelopeRequest(dsn, body);

  return { eventId: event.event_id ?? "" };
}

/**
 * Handle the default script output mode: substitute placeholders in the template, output.
 */
function handleScriptOutput(flags: BashHookFlags): BashHookResult {
  let script = BASH_TEMPLATE;

  // Default to 'sentry' (the command on PATH). The old Rust CLI used
  // env::current_exe() but that breaks for npm installs where process.execPath
  // is the Node binary. Using the bare command name works for all install methods
  // as long as the CLI is on PATH, which it must be for eval "$(sentry bash-hook)"
  // to have worked in the first place.
  const cliPath = flags.cli ?? "sentry";

  // Generate unique temp file paths for traceback and log
  const id = crypto.randomUUID();
  const tracebackFile = join(tmpdir(), `.sentry-${id}.traceback`);
  const logFile = join(tmpdir(), `.sentry-${id}.out`);

  // Use split/join instead of replace to avoid JavaScript's special $-pattern
  // expansion in replacement strings (e.g., $' inserts text after the match).
  script = script
    .split("___SENTRY_TRACEBACK_FILE___")
    .join(shellQuote(tracebackFile));
  script = script.split("___SENTRY_LOG_FILE___").join(shellQuote(logFile));
  script = script.split("___SENTRY_CLI___").join(shellQuote(cliPath));

  // Tags: each becomes ` --tag 'key:value'`
  const tagArgs = flags.tag
    ? flags.tag.map((t) => ` --tag ${shellQuote(t)}`).join("")
    : "";
  script = script.split("___SENTRY_TAGS___").join(tagArgs);

  // Release
  const releaseArg = flags.release
    ? ` --release ${shellQuote(flags.release)}`
    : "";
  script = script.split("___SENTRY_RELEASE___").join(releaseArg);

  // Prepend set -e unless --no-exit
  if (!flags["no-exit"]) {
    script = `set -e\n\n${script}`;
  }

  // If --dsn was provided, export it so the callback inherits it
  if (flags.dsn) {
    script = `export SENTRY_DSN=${shellQuote(flags.dsn)}\n${script}`;
  }

  return { script };
}

export const bashHookCommand = buildCommand({
  docs: {
    brief: "Print a bash script for shell error reporting",
    fullDescription:
      "Output a bash script snippet that, when eval'd, sets up ERR and EXIT\n" +
      "traps to automatically capture and report shell errors to Sentry.\n\n" +
      "Usage:\n" +
      '  eval "$(sentry bash-hook)"\n\n' +
      "The generated script requires SENTRY_DSN to be set in the environment.\n" +
      "When an error occurs, it calls back into the CLI to send the event.",
  },
  auth: "dsn",
  output: {
    human: formatBashHookHuman,
  },
  parameters: {
    flags: {
      "no-exit": {
        kind: "boolean",
        brief: "Do not prepend 'set -e' to the script",
        default: false,
        optional: true,
      },
      "no-environ": {
        kind: "boolean",
        brief: "No-op (environment variables are never sent)",
        default: false,
        optional: true,
      },
      "allow-xcode-infoplist-preprocessing": {
        kind: "boolean",
        brief:
          "No-op (kept for backward compatibility with old sentry-cli scripts)",
        default: false,
        optional: true,
      },
      cli: {
        kind: "parsed",
        parse: String,
        brief: "Override the sentry-cli command path in the generated script",
        optional: true,
      },
      tag: {
        kind: "parsed",
        parse: String,
        brief: "Add a tag as KEY:VALUE to the event (repeatable)",
        variadic: true,
        optional: true,
      },
      release: {
        kind: "parsed",
        parse: String,
        brief: "Set the release version for the event",
        optional: true,
      },
      dsn: {
        kind: "parsed",
        parse: String,
        brief: "DSN to send events to (overrides SENTRY_DSN env var)",
        optional: true,
      },
      // Hidden internal flags — used by the generated script's callback
      "send-event": {
        kind: "boolean",
        brief: "Internal: send a bash error event from traceback/log files",
        default: false,
        optional: true,
        hidden: true as const,
      },
      traceback: {
        kind: "parsed",
        parse: String,
        brief: "Internal: path to the traceback file",
        optional: true,
        hidden: true as const,
      },
      log: {
        kind: "parsed",
        parse: String,
        brief: "Internal: path to the log file",
        optional: true,
        hidden: true as const,
      },
    },
    aliases: {
      t: "tag",
      r: "release",
    },
  },
  async *func(this: SentryContext, flags: BashHookFlags) {
    if (flags["send-event"]) {
      yield new CommandOutput<SendEventResult>(await handleSendEvent(flags));
      return;
    }

    yield new CommandOutput<BashHookResult>(handleScriptOutput(flags));
  },
});
