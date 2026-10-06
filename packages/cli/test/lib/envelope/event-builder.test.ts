/**
 * Tests for buildEventFromFlags — converts CLI flags to a Sentry Event.
 *
 * Note: Core invariants (tag/extra parsing, user field routing) are property-
 * tested below. Unit tests here focus on specific edge cases and output shape.
 */

import { describe, expect, test } from "vitest";
import type { SendEventFlags } from "../../../src/lib/envelope/event-builder.js";
import {
  buildEventFromFlags,
  parseKeyValue,
  parseUserFields,
} from "../../../src/lib/envelope/event-builder.js";
import { ValidationError } from "../../../src/lib/errors.js";

// ── parseKeyValue ──────────────────────────────────────────────────

describe("parseKeyValue", () => {
  test("splits on first colon", async () => {
    expect(parseKeyValue("key:value")).toEqual(["key", "value"]);
  });

  test("value may contain colons", async () => {
    expect(parseKeyValue("url:https://example.com")).toEqual([
      "url",
      "https://example.com",
    ]);
  });

  test("no colon → throws ValidationError", async () => {
    expect(() => parseKeyValue("nocohere")).toThrow(ValidationError);
  });

  test("empty key → throws ValidationError", async () => {
    expect(() => parseKeyValue(":value")).toThrow(ValidationError);
  });

  test("splits on first equals sign", async () => {
    expect(parseKeyValue("key=value")).toEqual(["key", "value"]);
  });

  test("splits on whichever separator comes first", async () => {
    expect(parseKeyValue("key=a:b")).toEqual(["key", "a:b"]);
    expect(parseKeyValue("key:a=b")).toEqual(["key", "a=b"]);
  });

  test("leading equals sign → throws ValidationError", async () => {
    expect(() => parseKeyValue("=value")).toThrow(ValidationError);
  });

  test("leading colon before a later equals → throws ValidationError", async () => {
    expect(() => parseKeyValue(":key=value")).toThrow(ValidationError);
  });
});

// ── parseUserFields ───────────────────────────────────────────────

describe("parseUserFields", () => {
  test("id maps to user.id", async () => {
    expect(parseUserFields(["id:42"])).toMatchObject({ id: "42" });
  });

  test("email maps to user.email", async () => {
    expect(parseUserFields(["email:alice@example.com"])).toMatchObject({
      email: "alice@example.com",
    });
  });

  test("ip_address maps to user.ip_address", async () => {
    expect(parseUserFields(["ip_address:1.2.3.4"])).toMatchObject({
      ip_address: "1.2.3.4",
    });
  });

  test("username maps to user.username", async () => {
    expect(parseUserFields(["username:alice"])).toMatchObject({
      username: "alice",
    });
  });

  test("unknown keys go into user.data", async () => {
    expect(parseUserFields(["role:admin"])).toMatchObject({
      data: { role: "admin" },
    });
  });

  test("multiple pairs merged", async () => {
    const result = parseUserFields(["id:1", "email:a@b.com", "role:admin"]);
    expect(result).toMatchObject({
      id: "1",
      email: "a@b.com",
      data: { role: "admin" },
    });
  });
});

// ── buildEventFromFlags ───────────────────────────────────────────

describe("buildEventFromFlags", () => {
  function flags(overrides: Partial<SendEventFlags> = {}): SendEventFlags {
    return { "no-environ": true, ...overrides };
  }

  test("defaults: level=error, platform=other", async () => {
    const event = await buildEventFromFlags(flags());
    expect(event.level).toBe("error");
    expect(event.platform).toBe("other");
  });

  test("event_id is always a 32-char hex string", async () => {
    const event = await buildEventFromFlags(flags());
    expect(event.event_id).toMatch(/^[0-9a-f]{32}$/);
  });

  test("timestamp is a Unix float", async () => {
    const event = await buildEventFromFlags(flags());
    expect(typeof event.timestamp).toBe("number");
    expect(event.timestamp).toBeGreaterThan(0);
  });

  test("--timestamp with Unix epoch integer", async () => {
    const event = await buildEventFromFlags(flags({ timestamp: "1700000000" }));
    expect(event.timestamp).toBe(1_700_000_000);
  });

  test("--timestamp with Unix epoch float", async () => {
    const event = await buildEventFromFlags(
      flags({ timestamp: "1700000000.123" })
    );
    expect(event.timestamp).toBe(1_700_000_000.123);
  });

  test("--timestamp with ISO 8601 string", async () => {
    const event = await buildEventFromFlags(
      flags({ timestamp: "2024-01-15T12:00:00Z" })
    );
    // ISO 8601 → parsed via Date.parse, converted to seconds
    expect(event.timestamp).toBe(Date.parse("2024-01-15T12:00:00Z") / 1000);
  });

  test("--timestamp with invalid string throws ValidationError", async () => {
    await expect(
      buildEventFromFlags(flags({ timestamp: "not-a-date" }))
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("--timestamp with whitespace-only returns default (not epoch zero)", async () => {
    const event = await buildEventFromFlags(flags({ timestamp: "  " }));
    // Should fall back to Date.now(), not epoch 0
    expect(event.timestamp).toBeGreaterThan(1_700_000_000);
  });

  test("--level sets level", async () => {
    expect((await buildEventFromFlags(flags({ level: "warning" }))).level).toBe(
      "warning"
    );
  });

  test("--message joined with newline", async () => {
    const event = await buildEventFromFlags(
      flags({ message: ["hello", "world"] })
    );
    expect(event.logentry?.message).toBe("hello\nworld");
  });

  test("--message-arg sets params", async () => {
    const event = await buildEventFromFlags(
      flags({ message: ["hello %s"], "message-arg": ["world"] })
    );
    expect(event.logentry?.params).toEqual(["world"]);
  });

  test("--tag parses into tags object", async () => {
    const event = await buildEventFromFlags(
      flags({ tag: ["env:prod", "ver:1.0"] })
    );
    expect(event.tags).toEqual({ env: "prod", ver: "1.0" });
  });

  test("--extra parses into extra object", async () => {
    const event = await buildEventFromFlags(flags({ extra: ["foo:bar"] }));
    expect((event.extra as Record<string, string>).foo).toBe("bar");
  });

  test("--no-environ omits process.env from extra", async () => {
    const event = await buildEventFromFlags(flags({ "no-environ": true }));
    expect((event.extra as Record<string, unknown>)?.environ).toBeUndefined();
  });

  test("environ included when --no-environ not set", async () => {
    const event = await buildEventFromFlags(flags({ "no-environ": false }));
    expect((event.extra as Record<string, unknown>)?.environ).toBeDefined();
  });

  test("--user routes known fields correctly", async () => {
    const event = await buildEventFromFlags(
      flags({ user: ["id:99", "email:a@b.com"] })
    );
    expect(event.user?.id).toBe("99");
    expect(event.user?.email).toBe("a@b.com");
  });

  test("--fingerprint sets fingerprint array", async () => {
    const event = await buildEventFromFlags(
      flags({ fingerprint: ["my-error", "{{ default }}"] })
    );
    expect(event.fingerprint).toEqual(["my-error", "{{ default }}"]);
  });

  test("--release sets release", async () => {
    expect(
      (await buildEventFromFlags(flags({ release: "1.2.3" }))).release
    ).toBe("1.2.3");
  });

  test("--env sets environment", async () => {
    expect(
      (await buildEventFromFlags(flags({ env: "staging" }))).environment
    ).toBe("staging");
  });

  test("--platform sets platform", async () => {
    expect(
      (await buildEventFromFlags(flags({ platform: "python" }))).platform
    ).toBe("python");
  });

  test("--dist sets dist", async () => {
    expect((await buildEventFromFlags(flags({ dist: "x86" }))).dist).toBe(
      "x86"
    );
  });

  test("each call produces a unique event_id", async () => {
    const a = await buildEventFromFlags(flags());
    const b = await buildEventFromFlags(flags());
    expect(a.event_id).not.toBe(b.event_id);
  });

  test("--logfile attaches breadcrumbs from file", async () => {
    const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "sentry-logfile-test-"));
    const logPath = join(dir, "test.log");
    try {
      writeFileSync(logPath, "line one\nline two\nline three\n");
      const event = await buildEventFromFlags(flags({ logfile: logPath }));
      expect(event.breadcrumbs).toHaveLength(3);
      expect(event.breadcrumbs?.[0]?.message).toBe("line one");
      expect(event.breadcrumbs?.[0]?.category).toBe("log");
      expect(event.breadcrumbs?.[2]?.message).toBe("line three");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--logfile with --with-categories parses CATEGORY: message", async () => {
    const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "sentry-logfile-cat-"));
    const logPath = join(dir, "test.log");
    try {
      writeFileSync(
        logPath,
        "INFO: Server started\nERROR: Connection lost\nplain line\n"
      );
      const event = await buildEventFromFlags(
        flags({ logfile: logPath, "with-categories": true })
      );
      expect(event.breadcrumbs).toHaveLength(3);
      expect(event.breadcrumbs?.[0]).toMatchObject({
        category: "INFO",
        message: "Server started",
      });
      expect(event.breadcrumbs?.[1]).toMatchObject({
        category: "ERROR",
        message: "Connection lost",
      });
      // Line without category prefix falls back to "log"
      expect(event.breadcrumbs?.[2]).toMatchObject({
        category: "log",
        message: "plain line",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--logfile with nonexistent file throws ValidationError", async () => {
    await expect(
      buildEventFromFlags(flags({ logfile: "/nonexistent/logfile.log" }))
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("--logfile caps at 100 breadcrumbs", async () => {
    const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "sentry-logfile-cap-"));
    const logPath = join(dir, "big.log");
    try {
      const lines = Array.from({ length: 150 }, (_, i) => `line ${i}`).join(
        "\n"
      );
      writeFileSync(logPath, lines);
      const event = await buildEventFromFlags(flags({ logfile: logPath }));
      expect(event.breadcrumbs).toHaveLength(100);
      // Should keep the LAST 100 lines (50-149)
      expect(event.breadcrumbs?.[0]?.message).toBe("line 50");
      expect(event.breadcrumbs?.[99]?.message).toBe("line 149");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
