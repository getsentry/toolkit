// Imports the packed package as ES modules, as an npm consumer would.
import { strictEqual } from "node:assert";
import {
  createLogger,
  jsonReporter,
  type LogRecord,
  type SentryLogger,
  sentryReporter,
} from "@sentry/logger";

const records: LogRecord[] = [];
const lines: string[] = [];
const sentryCalls: string[] = [];
const sentryLogger: SentryLogger = {
  trace: () => {},
  debug: () => {},
  info: (message) => sentryCalls.push(message),
  warn: () => {},
  error: () => {},
};

const logger = createLogger({
  reporters: [
    { log: (record) => records.push(record) },
    jsonReporter({ stream: { write: (line) => lines.push(line) } }),
    sentryReporter(sentryLogger),
  ],
});
logger.withTag("esm").withAttributes({ user: "jane" }).info("hello %s", "you");

strictEqual(records[0]?.tag, "esm");
strictEqual(JSON.parse(lines[0] ?? "").user, "jane");
strictEqual(sentryCalls[0], "hello you");
