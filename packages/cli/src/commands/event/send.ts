/**
 * `sentry event send` — Send a Sentry event from CLI flags or a JSON file.
 *
 * Unlike most commands, this authenticates via a DSN (not a Bearer token).
 * The DSN is resolved in order:
 *   1. A positional `<dsn>`, `<project>`, or `<org>/<project>`
 *   2. SENTRY_DSN environment variable
 *   3. Auto-detection from the current project (`.env`, source, env files)
 */

import type { DsnComponents, Event } from "@sentry/core";
import { createEventEnvelope, makeDsn, serializeEnvelope } from "@sentry/core";
import type { SentryContext } from "../../context.js";
import { buildCommand } from "../../lib/command.js";
import {
  buildEventFromFlags,
  type SendEventFlags,
} from "../../lib/envelope/event-builder.js";
import {
  peelEventSendTarget,
  resolveEventSendDsn,
} from "../../lib/envelope/event-send-dsn.js";
import {
  readFileBytes,
  sendEnvelopeRequest,
} from "../../lib/envelope/transport.js";
import { ConfigError, ValidationError } from "../../lib/errors.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { logger } from "../../lib/logger.js";

const log = logger.withTag("event.send");

/** Shape of the data yielded to the output layer. */
type SendEventResult = {
  eventId: string;
  file?: string;
};

function formatSendEventHuman(result: SendEventResult): string {
  if (result.file) {
    return `Event from ${result.file} dispatched: ${result.eventId}`;
  }
  return `Event dispatched.\nEvent ID: ${result.eventId}`;
}

/**
 * Build the envelope body and extract the event ID for a file-based send.
 *
 * In raw mode the file bytes are sent as-is; in normal mode the JSON is
 * parsed, wrapped in an EventEnvelope, and re-serialized.
 */
async function buildFilePayload(
  file: string,
  raw: boolean,
  dsnComponents: DsnComponents
): Promise<{ body: string | Uint8Array; eventId: string }> {
  const bytes = await readFileBytes(file);

  if (raw) {
    // Best-effort: extract event_id from the first line (envelope header JSON).
    let eventId = "";
    try {
      const firstLine = new TextDecoder().decode(bytes).split("\n")[0] ?? "{}";
      const header = JSON.parse(firstLine) as Record<string, unknown>;
      eventId = (header.event_id as string) ?? "";
    } catch (err) {
      log.debug("Could not extract event_id from envelope header", err);
    }
    return { body: bytes, eventId };
  }

  let event: Event;
  try {
    event = JSON.parse(new TextDecoder().decode(bytes)) as Event;
  } catch (err) {
    throw new ValidationError(
      `Failed to parse JSON from ${file}: ${(err as Error).message}`,
      "path"
    );
  }

  let body: string | Uint8Array;
  try {
    const envelope = createEventEnvelope(event, dsnComponents);
    body = serializeEnvelope(envelope);
  } catch (err) {
    throw new ValidationError(
      `Failed to create envelope from ${file}: ${(err as Error).message}`,
      "path"
    );
  }
  return { body, eventId: event.event_id ?? "" };
}

export const sendCommand = buildCommand({
  docs: {
    brief: "Send a Sentry event",
    fullDescription: `\
Send a Sentry event to the ingest pipeline using DSN-based authentication.

The first positional may be a \`<dsn>\`, \`<project>\`, or
\`<org>/<project>\`. Project targets require login and must have exactly one
active DSN. Without a target, the command uses \`SENTRY_DSN\` or auto-detects
a DSN from the current project.

## Building an event from flags

\`\`\`
sentry event send -m "Something went wrong" -l error --tag env:prod
sentry event send sentry/cli -m "Something went wrong"
sentry event send "https://key@o123.ingest.us.sentry.io/456" -m "Test"
\`\`\`

## Sending from a JSON file

The JSON file must be a valid serialized Sentry Event object:

\`\`\`
sentry event send ./event.json
\`\`\`

Use --raw to skip JSON parsing and send the file bytes directly to the ingest endpoint.
This also supports sending pre-built Sentry envelope files.

When file arguments are provided, flags like -m/--message are ignored — the event is
built entirely from the file contents.

## Common flags

| Flag | Description |
|------|-------------|
| \`-m\` / \`--message\` | Event message (repeat for multi-line) |
| \`-l\` / \`--level\` | Severity: debug, info, warning, error, fatal |
| \`-r\` / \`--release\` | Release version |
| \`-E\` / \`--env\` | Environment name |
| \`-t\` / \`--tag\` | Tag as KEY:VALUE (repeat for multiple) |
| \`-e\` / \`--extra\` | Extra data as KEY:VALUE |
| \`-u\` / \`--user\` | User info as KEY:VALUE (id, email, username, ip_address) |
| \`-f\` / \`--fingerprint\` | Custom fingerprint parts (repeat) |
| \`--logfile\` | Attach last 100 log lines as breadcrumbs |
| \`--with-categories\` | Parse 'CATEGORY: message' from logfile lines |
`,
  },
  auth: "dsn",
  output: {
    human: formatSendEventHuman,
  },
  parameters: {
    positional: {
      kind: "array",
      parameter: {
        brief:
          "Optional DSN/project target followed by JSON event file path(s)",
        placeholder: "target-or-file",
        parse: String,
        optional: true,
      },
    },
    flags: {
      message: {
        kind: "parsed",
        parse: String,
        brief: "Event message (repeat for multi-line)",
        variadic: true,
        optional: true,
      },
      "message-arg": {
        kind: "parsed",
        parse: String,
        brief: "Arguments for message template (repeat for multiple)",
        variadic: true,
        optional: true,
      },
      level: {
        kind: "enum",
        values: ["debug", "info", "warning", "error", "fatal"],
        brief: "Event severity level",
        default: "error",
        optional: true,
      },
      release: {
        kind: "parsed",
        parse: String,
        brief: "Release version",
        optional: true,
      },
      dist: {
        kind: "parsed",
        parse: String,
        brief: "Distribution identifier",
        optional: true,
      },
      env: {
        kind: "parsed",
        parse: String,
        brief: "Environment name (e.g. production, staging)",
        optional: true,
      },
      platform: {
        kind: "parsed",
        parse: String,
        brief: "Platform identifier (default: other)",
        optional: true,
      },
      tag: {
        kind: "parsed",
        parse: String,
        brief: "Tag as KEY:VALUE (repeat for multiple)",
        variadic: true,
        optional: true,
      },
      extra: {
        kind: "parsed",
        parse: String,
        brief: "Extra data as KEY:VALUE (repeat for multiple)",
        variadic: true,
        optional: true,
      },
      user: {
        kind: "parsed",
        parse: String,
        brief:
          "User info as KEY:VALUE — id, email, username, ip_address, or custom",
        variadic: true,
        optional: true,
      },
      fingerprint: {
        kind: "parsed",
        parse: String,
        brief: "Custom fingerprint part (repeat for multiple)",
        variadic: true,
        optional: true,
      },
      timestamp: {
        kind: "parsed",
        parse: String,
        brief: "Event timestamp (Unix epoch, ISO 8601, or RFC 2822)",
        optional: true,
      },
      "no-environ": {
        kind: "boolean",
        brief: "Do not include environment variables in the event",
        default: false,
        optional: true,
      },
      logfile: {
        kind: "parsed",
        parse: String,
        brief:
          "Path to a log file — last 100 lines are attached as breadcrumbs",
        optional: true,
      },
      "with-categories": {
        kind: "boolean",
        brief: "Parse 'CATEGORY: message' prefixes from logfile breadcrumbs",
        default: false,
        optional: true,
      },
      raw: {
        kind: "boolean",
        brief: "Send file contents as-is without parsing",
        default: false,
        optional: true,
      },
    },
    aliases: {
      m: "message",
      a: "message-arg",
      l: "level",
      r: "release",
      d: "dist",
      E: "env",
      p: "platform",
      t: "tag",
      e: "extra",
      u: "user",
      f: "fingerprint",
    },
  },
  async *func(
    this: SentryContext,
    flags: SendEventFlags & {
      raw?: boolean;
      json?: boolean;
    },
    ...files: string[]
  ) {
    const { target, files: eventFiles } = peelEventSendTarget(files);
    const dsn = await resolveEventSendDsn(this.cwd, target);
    let dsnComponents: ReturnType<typeof makeDsn>;
    try {
      dsnComponents = makeDsn(dsn);
    } catch (err) {
      log.debug("makeDsn threw for DSN input", err);
      dsnComponents = undefined;
    }
    if (!dsnComponents) {
      throw new ValidationError(`Invalid DSN: ${dsn}`, "target");
    }

    if (eventFiles.length > 0) {
      for (const file of eventFiles) {
        const { body, eventId } = await buildFilePayload(
          file,
          flags.raw ?? false,
          dsnComponents
        );
        await sendEnvelopeRequest(dsn, body);
        yield new CommandOutput<SendEventResult>({ eventId, file });
      }
    } else {
      if (flags.raw) {
        throw new ValidationError(
          "--raw requires a file argument (raw bytes cannot be built from inline flags)",
          "raw"
        );
      }
      if (!flags.message?.length) {
        throw new ConfigError(
          "Provide a message via -m/--message or a JSON event file as a positional argument.",
          "sentry event send -m 'My message'"
        );
      }
      const event = await buildEventFromFlags(flags);
      let body: string | Uint8Array;
      try {
        const envelope = createEventEnvelope(event, dsnComponents);
        body = serializeEnvelope(envelope);
      } catch (err) {
        throw new ValidationError(
          `Failed to create event envelope: ${(err as Error).message}`,
          "event"
        );
      }
      await sendEnvelopeRequest(dsn, body);
      yield new CommandOutput<SendEventResult>({
        eventId: event.event_id ?? "",
      });
    }
  },
});
