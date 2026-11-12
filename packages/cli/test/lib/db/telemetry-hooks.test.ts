/**
 * The database modules never import telemetry. They must still trace through
 * the telemetry module the process loaded, not a second copy of it.
 */

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as Sentry from "@sentry/node";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  getDatabase,
  recordCacheHit,
  withDbSpan,
} from "../../../src/lib/db/index.js";
import "../../../src/lib/telemetry.js";
import { useTestConfigDir } from "../../helpers.js";

useTestConfigDir("test-db-telemetry-hooks-");

describe("database telemetry hooks", () => {
  // test/preload.ts turns telemetry off for every test.
  beforeEach(() => {
    delete process.env.SENTRY_CLI_NO_TELEMETRY;
  });

  afterEach(() => {
    process.env.SENTRY_CLI_NO_TELEMETRY = "1";
    vi.restoreAllMocks();
  });

  test("withDbSpan runs the operation in a db.operation span", () => {
    const startSpan = vi.spyOn(Sentry, "startSpan");

    expect(withDbSpan("testOp", () => 42)).toBe(42);
    expect(startSpan).toHaveBeenCalledWith(
      expect.objectContaining({ name: "testOp", op: "db.operation" }),
      expect.any(Function),
    );
  });

  test("recordCacheHit records the cache hit rate", () => {
    const distribution = vi.spyOn(Sentry.metrics, "distribution");

    recordCacheHit("test_cache", true);
    expect(distribution).toHaveBeenCalledWith("cache.hit_rate", 100, {
      attributes: { cache_name: "test_cache" },
    });
  });

  test("queries run in db spans", () => {
    const startSpan = vi.spyOn(Sentry, "startSpan");

    getDatabase().query("SELECT 1").get();
    expect(startSpan).toHaveBeenCalledWith(
      expect.objectContaining({ name: "SELECT 1", op: "db" }),
      expect.any(Function),
    );
  });

  test("SENTRY_CLI_NO_TELEMETRY=1 skips spans and metrics", () => {
    process.env.SENTRY_CLI_NO_TELEMETRY = "1";
    const startSpan = vi.spyOn(Sentry, "startSpan");
    const distribution = vi.spyOn(Sentry.metrics, "distribution");

    expect(withDbSpan("testOp", () => 42)).toBe(42);
    recordCacheHit("test_cache", true);
    getDatabase().query("SELECT 1").get();
    expect(startSpan).not.toHaveBeenCalled();
    expect(distribution).not.toHaveBeenCalled();
  });
});
