/** Newline-delimited JSON, one object per log call, for log collectors. */

import { recordFields } from "../fields.js";
import type { LogStream, Reporter } from "../types.js";

/** Options for {@link jsonReporter} and `logfmtReporter`. */
export type StreamReporterOptions = {
  /** Where lines go. Defaults to `process.stderr`. */
  stream?: LogStream;
};

/**
 * A reporter that writes each log call as one JSON line:
 *
 * ```json
 * {"time":"2026-01-15T14:28:59.000Z","level":"info","tag":"auth","msg":"Logged in","user":"jane"}
 * ```
 */
export function jsonReporter(options: StreamReporterOptions = {}): Reporter {
  return {
    log(record) {
      const line = JSON.stringify(Object.fromEntries(recordFields(record)));
      (options.stream ?? process.stderr).write(`${line}\n`);
    },
  };
}
