/**
 * Home-directory fallback safety tests.
 *
 * When DSN auto-detection runs from `$HOME` (or any directory without a
 * project marker), `findProjectRoot` falls back to `$HOME`. A downward
 * scan from there would reach OS app-data and credential directories
 * (`~/Library`, `~/.ssh`, `~/.aws`, …), tripping security monitoring and
 * opening sensitive files for the content sniff. These tests lock in that
 * the scan is skipped in that case. See getsentry/cli#1590.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { fakeHome } = vi.hoisted(() => ({ fakeHome: { path: "" } }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => fakeHome.path,
  };
});

import { clearDsnCache } from "../../../src/lib/db/dsn-cache.js";
import { detectAllDsns, detectDsn } from "../../../src/lib/dsn/detector.js";
import { useTestConfigDir } from "../../helpers.js";

const getConfigDir = useTestConfigDir("test-dsn-home-fallback-");

describe("DSN detection from $HOME fallback", () => {
  let home: string;

  beforeEach(() => {
    home = join(getConfigDir(), "home");
    mkdirSync(home, { recursive: true });
    fakeHome.path = home;
    clearDsnCache(home);
    delete process.env.SENTRY_DSN;
  });

  afterEach(() => {
    fakeHome.path = "";
    delete process.env.SENTRY_DSN;
  });

  test("does not scan into sensitive dirs under $HOME", async () => {
    // A DSN-shaped string planted in a credential-like file under $HOME.
    // If the downward scan ran, detection would surface it.
    const sensitiveDsn = "https://leaked@o999.ingest.sentry.io/999";
    mkdirSync(join(home, "Library", "Group Containers", "x.1password"), {
      recursive: true,
    });
    writeFileSync(
      join(home, "Library", "Group Containers", "x.1password", "config.json"),
      `{ "dsn": "${sensitiveDsn}" }`
    );
    mkdirSync(join(home, ".aws"), { recursive: true });
    writeFileSync(
      join(home, ".aws", "credentials"),
      `sentry_dsn=${sensitiveDsn}`
    );

    const result = await detectDsn(home);
    expect(result).toBeNull();

    const all = await detectAllDsns(home);
    expect(all.all).toHaveLength(0);
    expect(all.primary).toBeNull();
  });

  test("skips the scan even when $HOME carries a trailing slash", async () => {
    // getStopBoundary() returns homedir() raw; a trailing slash must not
    // make the home-fallback skip fail open. See getsentry/cli#1590.
    fakeHome.path = `${home}/`;
    // Plant the DSN in a plain code file at the top of $HOME — not inside
    // a DSN_ADDITIONAL_SKIP_DIRS directory — so that if isHomeOrAncestor
    // regressed to failing open, the downward scan WOULD reach and return
    // it. That makes this test actually exercise the resolve() fix rather
    // than the skip list.
    const scannedDsn = "https://leaked@o999.ingest.sentry.io/999";
    writeFileSync(
      join(home, "config.ts"),
      `Sentry.init({ dsn: "${scannedDsn}" });`
    );

    const result = await detectDsn(home);
    expect(result).toBeNull();
  });

  test("still returns SENTRY_DSN env var when set from $HOME", async () => {
    const envDsn = "https://var@o111.ingest.sentry.io/111";
    process.env.SENTRY_DSN = envDsn;

    const result = await detectDsn(home);
    expect(result?.raw).toBe(envDsn);
    expect(result?.source).toBe("env");

    const all = await detectAllDsns(home);
    expect(all.primary?.raw).toBe(envDsn);
    expect(all.all).toHaveLength(1);
  });

  test("scans normally when a project marker exists under $HOME", async () => {
    const projectDsn = "https://code@o222.ingest.sentry.io/222";
    const project = join(home, "projects", "app");
    mkdirSync(join(project, ".git"), { recursive: true });
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(
      join(project, "src", "config.ts"),
      `Sentry.init({ dsn: "${projectDsn}" })`
    );

    const result = await detectDsn(project);
    expect(result?.raw).toBe(projectDsn);
    expect(result?.source).toBe("code");
  });

  describe("from an ancestor of $HOME", () => {
    let ancestor: string;

    beforeEach(() => {
      // e.g. running from /Users when $HOME is /Users/alice. findProjectRoot
      // finds no markers and falls back to the ancestor itself, which
      // isHomeOrAncestor still treats as at/above home — the downward scan
      // must be skipped there too, or it would walk straight into every
      // user's home directory.
      ancestor = join(getConfigDir(), "ancestor");
      home = join(ancestor, "alice");
      mkdirSync(home, { recursive: true });
      fakeHome.path = home;
      clearDsnCache(ancestor);
    });

    test("does not scan into sibling home directories", async () => {
      const scannedDsn = "https://leaked@o999.ingest.sentry.io/999";
      // A plain code file directly under the ancestor — reachable by the
      // downward scan only if the home-fallback skip fails to trigger.
      writeFileSync(
        join(ancestor, "config.ts"),
        `Sentry.init({ dsn: "${scannedDsn}" });`
      );
      // And one inside a would-be sibling home, to mirror the real risk.
      const sibling = join(ancestor, "bob");
      mkdirSync(sibling, { recursive: true });
      writeFileSync(
        join(sibling, "config.ts"),
        `Sentry.init({ dsn: "${scannedDsn}" });`
      );

      const result = await detectDsn(ancestor);
      expect(result).toBeNull();

      const all = await detectAllDsns(ancestor);
      expect(all.all).toHaveLength(0);
      expect(all.primary).toBeNull();
    });

    test("still returns SENTRY_DSN env var when set from an ancestor", async () => {
      const envDsn = "https://var@o333.ingest.sentry.io/333";
      process.env.SENTRY_DSN = envDsn;

      const result = await detectDsn(ancestor);
      expect(result?.raw).toBe(envDsn);
      expect(result?.source).toBe("env");

      const all = await detectAllDsns(ancestor);
      expect(all.primary?.raw).toBe(envDsn);
      expect(all.all).toHaveLength(1);
    });
  });
});
