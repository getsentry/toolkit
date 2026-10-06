/**
 * sentry monitor run
 *
 * Wrap an arbitrary command with cron monitor check-ins. Sends an
 * `in_progress` check-in when the command starts, then `ok`/`error` (with
 * duration) on completion based on the child's exit code.
 *
 * Check-ins are sent via DSN (not an auth token), reusing the envelope
 * transport in `src/lib/envelope/`. The DSN is resolved from `--dsn`, the
 * `SENTRY_DSN` env var, or by auto-detecting it from the project sources.
 *
 * The wrapped command inherits the parent's stdio and signals (SIGINT/SIGTERM
 * are forwarded), and its exit code is preserved. Check-in send failures are
 * non-fatal — they are logged and the wrapped command still runs and exits
 * with its own code.
 */

import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import {
  createCheckInEnvelope,
  makeDsn,
  serializeEnvelope,
  uuid4,
} from "@sentry/core";
import type { SentryContext } from "../../context.js";
import { buildCommand, numberParser } from "../../lib/command.js";
import {
  buildCheckIn,
  buildMonitorConfig,
  type CheckInConfigFlags,
} from "../../lib/envelope/checkin-builder.js";
import {
  resolveIngestDsn,
  sendEnvelopeRequest,
} from "../../lib/envelope/transport.js";
import { CliError, ConfigError, ValidationError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";

const log = logger.withTag("monitor.run");

/** Usage hint shown when no command is provided. */
const USAGE_HINT = "sentry monitor run <monitor-slug> -- <command>";

type RunFlags = CheckInConfigFlags & {
  dsn?: string;
  environment: string;
};

/** Parse a positive integer flag value (minimum 1). */
function parsePositiveInt(value: string): number {
  const num = numberParser(value);
  if (!Number.isInteger(num) || num < 1) {
    throw new ValidationError(
      `Invalid value: ${value}. Must be a positive integer.`,
      "monitor-config"
    );
  }
  return num;
}

/**
 * Resolve the DSN to send check-ins to.
 *
 * Priority: `--dsn` flag → `SENTRY_DSN` env var → auto-detected project DSN.
 * Throws {@link ConfigError} if none can be found.
 */
async function resolveCheckInDsn(
  flags: RunFlags,
  cwd: string
): Promise<string> {
  const dsn = await resolveIngestDsn(flags, cwd);
  if (dsn) {
    return dsn;
  }

  throw new ConfigError(
    "No DSN found. Provide one via --dsn <dsn>, set the SENTRY_DSN environment variable, or run from a project where a DSN can be detected.",
    USAGE_HINT
  );
}

/** Maximum time (ms) to wait for a check-in envelope to be sent. */
const CHECKIN_SEND_TIMEOUT_MS = 30_000;

/**
 * Send a check-in envelope, swallowing (but logging) any error.
 *
 * Check-in delivery must never abort or stall the wrapped command, so:
 * - Failures are non-fatal (logged, then continues).
 * - A timeout prevents a slow/unreachable ingest endpoint from blocking
 *   the child process spawn or exit.
 */
async function sendCheckInSafely(
  dsn: string,
  dsnComponents: ReturnType<typeof makeDsn>,
  checkIn: ReturnType<typeof buildCheckIn>,
  phase: "in-progress" | "final"
): Promise<void> {
  try {
    const envelope = createCheckInEnvelope(
      checkIn,
      undefined,
      undefined,
      undefined,
      dsnComponents
    );
    const body = serializeEnvelope(envelope);
    const send = sendEnvelopeRequest(dsn, body);
    // Prevent unhandled rejection if the timeout wins the race but the
    // fetch later rejects (Node 15+ terminates on unhandled rejections).
    // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    send.catch(() => {
      // Intentionally empty — prevents unhandled rejection if timeout wins.
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        reject,
        CHECKIN_SEND_TIMEOUT_MS,
        new Error("Check-in send timed out")
      );
    });
    try {
      await Promise.race([send, timeout]);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    log.warn(
      `Failed to send ${phase} check-in: ${err instanceof Error ? err.message : String(err)}`
    );
    log.debug("Continuing despite check-in failure...");
  }
}

export const runCommand = buildCommand({
  docs: {
    brief: "Wrap a command with cron monitor check-ins",
    fullDescription: `\
Run a command and report its execution to a Sentry cron monitor.

An \`in_progress\` check-in is sent when the command starts, then an \`ok\` or
\`error\` check-in (with duration) is sent when it finishes, based on the exit
code. The wrapped command's stdio and signals are forwarded and its exit code
is preserved.

Check-ins are sent via DSN — no \`sentry auth login\` required. The DSN is
resolved from \`--dsn\`, the \`SENTRY_DSN\` environment variable, or by
auto-detecting it from your project sources.

## Usage

\`\`\`
sentry monitor run <monitor-slug> -- <command>
\`\`\`

The \`--\` separator is recommended so flags belonging to your command are not
interpreted by \`monitor run\`. It is optional when your command has no flags:

\`\`\`
sentry monitor run nightly-job -- python manage.py cron
sentry monitor run nightly-job npm run task        # -- optional here
\`\`\`

## Creating/updating the monitor

Pass \`--schedule\` (crontab format) to upsert the monitor on the first
check-in. Dependent flags require \`--schedule\`:

\`\`\`
sentry monitor run nightly-job -s "0 0 * * *" --max-runtime 30 --timezone UTC -- ./backup.sh
\`\`\`

The wrapped command receives the \`SENTRY_MONITOR_SLUG\` environment variable.`,
  },
  auth: "dsn",
  parameters: {
    positional: {
      kind: "array",
      parameter: {
        brief: "Monitor slug followed by the command to run",
        parse: String,
        placeholder: "monitor-slug command",
      },
    },
    flags: {
      dsn: {
        kind: "parsed",
        parse: String,
        brief: "DSN to send check-ins to (overrides SENTRY_DSN env var)",
        optional: true,
      },
      environment: {
        kind: "parsed",
        parse: String,
        brief: "Environment of the monitor",
        default: "production",
      },
      schedule: {
        kind: "parsed",
        parse: String,
        brief:
          "Upsert the monitor with this crontab schedule (e.g. '0 * * * *')",
        optional: true,
      },
      "check-in-margin": {
        kind: "parsed",
        parse: parsePositiveInt,
        brief:
          "Minutes after the expected check-in before it is missed (requires --schedule)",
        optional: true,
      },
      "max-runtime": {
        kind: "parsed",
        parse: parsePositiveInt,
        brief:
          "Minutes a check-in may run before timing out (requires --schedule)",
        optional: true,
      },
      timezone: {
        kind: "parsed",
        parse: String,
        brief:
          "Timezone of the schedule, tz database string (requires --schedule)",
        optional: true,
      },
      "failure-issue-threshold": {
        kind: "parsed",
        parse: parsePositiveInt,
        brief:
          "Consecutive failures before an issue is created (requires --schedule)",
        optional: true,
      },
      "recovery-threshold": {
        kind: "parsed",
        parse: parsePositiveInt,
        brief:
          "Consecutive successes before an issue is resolved (requires --schedule)",
        optional: true,
      },
    },
    aliases: {
      e: "environment",
      s: "schedule",
    },
  },
  async *func(this: SentryContext, flags: RunFlags, ...rawArgs: string[]) {
    const { cwd } = this;

    // The scanner consumes the "--" escape token (allowArgumentEscapeSequence
    // is enabled in app.ts), but strip a leading one defensively in case it is
    // ever passed through (e.g. via a wrapping shell).
    const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
    const monitorSlug = args[0];
    const command = args.slice(1);

    if (!monitorSlug) {
      throw new ValidationError(
        `No monitor slug provided. Usage: ${USAGE_HINT}`,
        "monitor-slug"
      );
    }
    if (command.length === 0) {
      throw new ValidationError(
        `No command provided. Usage: ${USAGE_HINT}`,
        "command"
      );
    }

    // Validate config flags (throws if a dependent flag lacks --schedule).
    const monitorConfig = buildMonitorConfig(flags);

    const dsn = await resolveCheckInDsn(flags, cwd);
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

    const checkInId = uuid4();
    const { environment } = flags;

    // Opening check-in carries the upsert config (if any).
    await sendCheckInSafely(
      dsn,
      dsnComponents,
      buildCheckIn({
        checkInId,
        monitorSlug,
        status: "in_progress",
        environment,
        monitorConfig,
      }),
      "in-progress"
    );

    const startedAt = Date.now();

    const [cmd = "", ...cmdArgs] = command;
    const child = spawn(cmd, cmdArgs, {
      env: {
        ...process.env,
        SENTRY_MONITOR_SLUG: monitorSlug,
      },
      stdio: "inherit",
    });

    // Forward signals so the whole process tree shuts down together.
    const onSigint = () => child.kill("SIGINT");
    const onSigterm = () => child.kill("SIGTERM");
    // Use `on` (not `once`) so repeated signals are still forwarded to the
    // child instead of letting Node's default handler kill the parent — which
    // would skip the closing check-in and leave the monitor stuck in_progress.
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);

    let exitCode: number;
    let spawnError: Error | undefined;
    try {
      exitCode = await new Promise<number>((resolve) => {
        let settled = false;
        child.on("close", (code, signal) => {
          if (!settled) {
            settled = true;
            if (code !== null) {
              resolve(code);
            } else if (signal) {
              // Map signal kills to 128+N (Unix convention: e.g. 130 for
              // SIGINT, 137 for SIGKILL, 143 for SIGTERM) so CI pipelines
              // and shell scripts inspecting $? see the correct exit code.
              const sigNum =
                osConstants.signals[signal as keyof typeof osConstants.signals];
              resolve(128 + (sigNum ?? 1));
            } else {
              resolve(1);
            }
          }
        });
        // If spawn itself fails (e.g. ENOENT), 'close' may never fire.
        // Record the error, treat as a failed run (exit code 1) so the close
        // check-in still reports an `error` status, then surface a CliError.
        child.on("error", (err) => {
          log.debug(`Child process error: ${err.message}`);
          if (!settled) {
            settled = true;
            spawnError = err;
            resolve(1);
          }
        });
      });
    } finally {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    }

    const durationSeconds = (Date.now() - startedAt) / 1000;

    // Closing check-in: status from exit code, with duration. No config.
    await sendCheckInSafely(
      dsn,
      dsnComponents,
      buildCheckIn({
        checkInId,
        monitorSlug,
        status: exitCode === 0 ? "ok" : "error",
        environment,
        duration: durationSeconds,
      }),
      "final"
    );

    if (spawnError) {
      throw new CliError(`Failed to start "${cmd}": ${spawnError.message}`, 1);
    }

    if (exitCode !== 0) {
      throw new CliError(`Process exited with code ${exitCode}`, exitCode);
    }
  },
});
