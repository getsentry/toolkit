import { Buffer } from "node:buffer";
import { afterEach, beforeEach, expect, test } from "vitest";
import { getConfiguredSentryUrl } from "../../src/lib/constants.js";
import {
  getEnvTokenHost,
  resetEnvTokenHostForTesting,
} from "../../src/lib/env-token-host.js";
import { ConfigError } from "../../src/lib/errors.js";
import { useEnvSandbox } from "../helpers.js";

useEnvSandbox([
  "SENTRY_AUTH_TOKEN",
  "SENTRY_TOKEN",
  "SENTRY_HOST",
  "SENTRY_URL",
]);

beforeEach(() => {
  for (const key of [
    "SENTRY_AUTH_TOKEN",
    "SENTRY_TOKEN",
    "SENTRY_HOST",
    "SENTRY_URL",
  ]) {
    delete process.env[key];
  }
  resetEnvTokenHostForTesting();
});
afterEach(() => {
  resetEnvTokenHostForTesting();
});

function orgToken(url: string): string {
  const claim = Buffer.from(JSON.stringify({ iat: 1, url })).toString("base64");
  return `sntrys_${claim}_secret`;
}

test("invalid SENTRY_HOST never falls through to a lower-priority URL", () => {
  process.env.SENTRY_HOST = "https://user:password@example.com";
  process.env.SENTRY_URL = "https://lower-priority.example.com";
  expect(() => getConfiguredSentryUrl()).toThrow(ConfigError);
});

test("an invalid active token claim never falls through to SaaS", () => {
  process.env.SENTRY_AUTH_TOKEN = orgToken("ftp://invalid.example.com");
  expect(() => getEnvTokenHost()).toThrow(ConfigError);
});
