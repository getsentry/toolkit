// Measures what the logger adds on top of the cheapest code that does the same
// job, using the built package in dist/. Run with
// `pnpm --filter @sentry/logger run bench`.
//
// Each case runs in its own process, so one case's JIT feedback cannot slow
// another. A baseline does the unavoidable part of the work: nothing for a
// call that is filtered out or reaches a no-op reporter, and `util.format`,
// `toISOString()`, and `JSON.stringify` plus a stream write for reporters that
// write text. Times are medians of timed samples, in nanoseconds per call.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { formatWithOptions } from "node:util";

const SAMPLES = 9;
const SAMPLE_MS = 100;
const STARTUP_RUNS = 21;
const ENTRY = new URL("../dist/index.js", import.meta.url).href;

const groups = [
  ["filtered out (debug at the info level)", ["noop", "debug"]],
  ["no-op reporter", ["noop", "noopReporter"]],
  ["fancy line, CI", ["formatWrite", "fancyPlain"]],
  ["fancy line, colors", ["formatWrite", "fancyColor"]],
  ["JSON line", ["jsonWrite", "json"]],
  ["logfmt line", ["jsonWrite", "logfmt"]],
  ["logfmt line, nested attribute", ["jsonWrite", "logfmtNested"]],
  ["Sentry structured log", ["formatSentry", "sentry"]],
];

const labels = {
  noop: "baseline: no-op function",
  debug: "logger.debug()",
  noopReporter: "logger.info()",
  formatWrite: "baseline: util.format + write",
  fancyPlain: "fancyReporter",
  fancyColor: "fancyReporter",
  jsonWrite: "baseline: toISOString + JSON.stringify + write",
  json: "jsonReporter",
  logfmt: "logfmtReporter",
  logfmtNested: "logfmtReporter",
  formatSentry: "baseline: util.format + Sentry.logger.info",
  sentry: "sentryReporter",
};

/** Build the function a child process times, for one case name. */
async function setUp(name) {
  const {
    createLogger,
    fancyReporter,
    jsonReporter,
    logfmtReporter,
    sentryReporter,
  } = await import(ENTRY);
  let sink;
  const stream = { write: (chunk) => (sink = chunk) };
  const send = (message, attributes) => (sink = attributes ?? message);
  const sentryLogger = {
    trace: send,
    debug: send,
    info: send,
    warn: send,
    error: send,
  };
  const attributes = { user: "jane", "http.status_code": 200 };
  const logger = (reporter) =>
    createLogger({ reporters: [reporter] })
      .withTag("bench")
      .withAttributes(attributes);
  const format = () =>
    formatWithOptions({ colors: false }, "Logged in as %s", "jane");

  switch (name) {
    case "noop": {
      const noop = (...args) => (sink = args);
      return () => noop("Logged in as %s", "jane");
    }
    case "debug": {
      const log = logger({ log: (record) => (sink = record) });
      return () => log.debug("Logged in as %s", "jane");
    }
    case "noopReporter": {
      const log = logger({ log: (record) => (sink = record) });
      return () => log.info("Logged in as %s", "jane");
    }
    case "formatWrite":
      return () => stream.write(`${format()}\n`);
    case "fancyPlain": {
      const log = logger(fancyReporter({ stream, env: () => ({ CI: "1" }) }));
      return () => log.info("Logged in as %s", "jane");
    }
    case "fancyColor": {
      const colorStream = { ...stream, columns: 120 };
      const env = () => ({ FORCE_COLOR: "1" });
      const log = logger(fancyReporter({ stream: colorStream, env }));
      return () => log.info("Logged in as %s", "jane");
    }
    case "jsonWrite":
      return () =>
        stream.write(
          `${JSON.stringify({
            time: new Date().toISOString(),
            level: "info",
            tag: "bench",
            msg: format(),
            ...attributes,
          })}\n`,
        );
    case "json": {
      const log = logger(jsonReporter({ stream }));
      return () => log.info("Logged in as %s", "jane");
    }
    case "logfmt": {
      const log = logger(logfmtReporter({ stream }));
      return () => log.info("Logged in as %s", "jane");
    }
    case "logfmtNested": {
      const log = createLogger({ reporters: [logfmtReporter({ stream })] })
        .withTag("bench")
        .withAttributes({ user: "jane", http: { status_code: 200 } });
      return () => log.info("Logged in as %s", "jane");
    }
    case "formatSentry":
      return () =>
        sentryLogger.info(format(), { ...attributes, "logger.tag": "bench" });
    case "sentry": {
      const log = logger(sentryReporter(sentryLogger));
      return () => log.info("Logged in as %s", "jane");
    }
    default:
      throw new Error(`Unknown case: ${name}`);
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Nanoseconds per call of `fn`: the median of timed samples, after a warm-up. */
function measure(fn) {
  const sample = () => {
    let calls = 0;
    const start = process.hrtime.bigint();
    const deadline = start + BigInt(SAMPLE_MS * 1e6);
    let now = start;
    while (now < deadline) {
      for (let i = 0; i < 1000; i++) {
        fn();
      }
      calls += 1000;
      now = process.hrtime.bigint();
    }
    return Number(now - start) / calls;
  };
  sample();
  return median(Array.from({ length: SAMPLES }, sample));
}

/** Median wall time, in milliseconds, of a fresh `node` running `code`. */
function startupTime(code) {
  return median(
    Array.from({ length: STARTUP_RUNS }, () => {
      const start = process.hrtime.bigint();
      execFileSync(process.execPath, ["--input-type=module", "-e", code]);
      return Number(process.hrtime.bigint() - start) / 1e6;
    }),
  );
}

const [caseName] = process.argv.slice(2);
if (caseName) {
  process.stdout.write(String(measure(await setUp(caseName))));
} else {
  const script = fileURLToPath(import.meta.url);
  const time = (name) =>
    Number(
      execFileSync(process.execPath, [script, name], { encoding: "utf8" }),
    );
  const ns = (value) => `${value.toFixed(value < 10 ? 1 : 0)} ns`;
  const rows = [];
  for (const [group, [baselineName, name]] of groups) {
    const baseline = time(baselineName);
    const result = time(name);
    rows.push({
      group,
      baseline: `${ns(baseline)} (${labels[baselineName].replace("baseline: ", "")})`,
      logger: `${ns(result)} (${labels[name]})`,
      overhead: `${result >= baseline ? "+" : ""}${ns(result - baseline)}`,
    });
  }

  // The baseline imports the Node built-ins the logger uses, which a CLI loads
  // anyway, and an empty ES module, which starts the module loader.
  const empty = startupTime(
    `await import("node:path"); await import("node:util"); await import("data:text/javascript,");`,
  );
  const loaded = startupTime(
    `const { createLogger } = await import(${JSON.stringify(ENTRY)}); createLogger();`,
  );
  rows.push({
    group: "startup",
    baseline: `${empty.toFixed(1)} ms (import node:util, node:path)`,
    logger: `${loaded.toFixed(1)} ms (import + createLogger())`,
    overhead: `${loaded >= empty ? "+" : ""}${(loaded - empty).toFixed(1)} ms`,
  });

  console.log(`Node ${process.version}, ${process.platform}-${process.arch}`);
  console.table(rows);
}
