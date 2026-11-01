// Requires the packed package as CommonJS, as an npm consumer would.
import { strictEqual } from "node:assert";
import logger = require("@sentry/logger");

const lines: string[] = [];
logger
  .createLogger({
    reporters: [
      logger.logfmtReporter({ stream: { write: (line) => lines.push(line) } }),
    ],
  })
  .withTag("cjs")
  .info("hello");

strictEqual(lines[0]?.includes(" tag=cjs msg=hello\n"), true);
