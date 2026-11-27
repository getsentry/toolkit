/**
 * A target-scoped invocation (`limitToTarget`) is enforced in the API
 * transport, so a request that goes around it is not checked. This test
 * fails when a source file sends a request with `fetch()` or `customFetch()`
 * itself, unless it applies the scope (`withTargetScope`) or is known not
 * to send the CLI's credential to the Sentry API.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const SRC = join(import.meta.dirname, "../../src");

/** Files that send requests without the CLI's Sentry credential. */
const WITHOUT_SENTRY_CREDENTIAL = [
  // The transport itself, and the helper it and others fetch with.
  "lib/sentry-client.ts",
  "lib/custom-ca.ts",
  // The login flow, before there is a credential.
  "lib/oauth.ts",
  // Telemetry envelopes, to the DSN.
  "lib/envelope/transport.ts",
  // CLI upgrades, release notes and Sentry's status page.
  "lib/binary.ts",
  "lib/delta-upgrade.ts",
  "lib/ghcr.ts",
  "lib/release-notes.ts",
  "lib/api/status-page.ts",
  // Services outside the Sentry API: `sentry init`'s docs agent and the
  // games leaderboard.
  "lib/docs-service.ts",
  "lib/games/leaderboard-api.ts",
  // Objectstore uploads, with the pre-signed token Sentry issues for them.
  "lib/objectstore.ts",
  // Local servers: Sentry Local and the React Native bundler.
  "commands/local/daemon.ts",
  "commands/local/server.ts",
  "commands/react-native/xcode.ts",
];

/** A `fetch(` or `customFetch(` call, outside comments. */
const FETCH_CALL = /(?:^|[^.\w])(?:fetch|customFetch)\(/;
const COMMENT_LINE = /^\s*(?:\*|\/\/|\/\*)/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("the target scope", () => {
  test("covers every request the CLI sends with its credential", () => {
    const unguarded = sourceFiles(SRC)
      .map((path) => ({
        file: relative(SRC, path),
        source: readFileSync(path, "utf8"),
      }))
      .filter(
        ({ source }) =>
          source
            .split("\n")
            .some(
              (line) => !COMMENT_LINE.test(line) && FETCH_CALL.test(line),
            ) && !source.includes("withTargetScope"),
      )
      .map(({ file }) => file)
      .sort();
    // A new file here sends a request around the API transport. Send it
    // through `getSdkConfig()`'s fetch, or wrap its fetch in
    // `withTargetScope()`; add it above only if it never sends the CLI's
    // credential to the Sentry API.
    expect(unguarded).toEqual([...WITHOUT_SENTRY_CREDENTIAL].sort());
  });
});
