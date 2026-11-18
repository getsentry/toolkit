#!/usr/bin/env node
// A tiny app for `sentry local run` to wrap. It uses the real Sentry Node SDK,
// which reads SENTRY_SPOTLIGHT on its own, sends one error, and prints
// `SDK_EVENT:<event id>` to stderr. With --none it sends nothing.
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv.includes("--none")) process.exit(0);

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
// The SDK is a dependency of the CLI package, not of the repo root.
const Sentry = createRequire(join(repo, "packages/cli/package.json"))(
  "@sentry/node",
);

Sentry.init({ tracesSampleRate: 1 });
const id = Sentry.captureException(new Error("verify-toolkit local error"));
console.error(`SDK_EVENT:${id}`);
await Sentry.close(2000);
