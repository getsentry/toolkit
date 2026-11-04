/**
 * `--require` preload that sends the CLI's telemetry to a local mock ingest
 * server at `127.0.0.1:$MOCK_INGEST_PORT` instead of Sentry.
 */
const http = require("node:http");
const https = require("node:https");

const port = Number(process.env.MOCK_INGEST_PORT);
const ingestHost = /^o\d+\.ingest\.(\w+\.)?sentry\.io$/;
const httpsRequest = https.request;

https.request = function request(options, ...rest) {
  if (
    typeof options === "object" &&
    !(options instanceof URL) &&
    ingestHost.test(options.hostname ?? "")
  ) {
    const local = Object.assign({}, options, {
      agent: undefined,
      ca: undefined,
      protocol: "http:",
      hostname: "127.0.0.1",
      port,
    });
    return http.request(local, ...rest);
  }
  return httpsRequest.call(this, options, ...rest);
};
