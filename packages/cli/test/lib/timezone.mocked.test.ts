/**
 * OS timezone-detection tests for src/lib/timezone.ts with node:fs and
 * node:child_process mocked before import.
 *
 * The detection strategies (`/etc/timezone`, the `/etc/localtime` symlink,
 * and `tzutil /g` on Windows) read real OS state, which is not deterministic
 * in CI. Mocking the filesystem and the tzutil shell-out lets us exercise
 * every branch of `detectOsTimezone` and drive `initTimezone`'s repair path
 * through a detected IANA name rather than the fixed-offset fallback.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  /** Contents returned by readFileSync("/etc/timezone"), or an Error to throw. */
  etcTimezone: undefined as string | Error | undefined,
  /** Target returned by readlinkSync("/etc/localtime"), or an Error to throw. */
  localtimeLink: undefined as string | Error | undefined,
  /** stdout returned by execSync("tzutil /g"), or an Error to throw. */
  tzutil: undefined as string | Error | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn((path: string, ...rest: unknown[]) => {
      if (path === "/etc/timezone") {
        if (mocks.etcTimezone instanceof Error) {
          throw mocks.etcTimezone;
        }
        if (mocks.etcTimezone === undefined) {
          throw new Error("ENOENT: /etc/timezone");
        }
        return mocks.etcTimezone;
      }
      return (actual.readFileSync as (...a: unknown[]) => unknown)(
        path,
        ...rest
      );
    }),
    readlinkSync: vi.fn((path: string, ...rest: unknown[]) => {
      if (path === "/etc/localtime") {
        if (mocks.localtimeLink instanceof Error) {
          throw mocks.localtimeLink;
        }
        if (mocks.localtimeLink === undefined) {
          throw new Error("ENOENT: /etc/localtime");
        }
        return mocks.localtimeLink;
      }
      return (actual.readlinkSync as (...a: unknown[]) => unknown)(
        path,
        ...rest
      );
    }),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execSync: vi.fn((command: string, ...rest: unknown[]) => {
      if (command === "tzutil /g") {
        if (mocks.tzutil instanceof Error) {
          throw mocks.tzutil;
        }
        if (mocks.tzutil === undefined) {
          throw new Error("tzutil not found");
        }
        return mocks.tzutil;
      }
      return (actual.execSync as (...a: unknown[]) => unknown)(
        command,
        ...rest
      );
    }),
  };
});

import { detectOsTimezone, initTimezone } from "../../src/lib/timezone.js";

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

beforeEach(() => {
  mocks.etcTimezone = undefined;
  mocks.localtimeLink = undefined;
  mocks.tzutil = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  setPlatform(originalPlatform);
});

describe("detectOsTimezone on Unix", () => {
  beforeEach(() => {
    setPlatform("linux");
  });

  test("prefers a valid /etc/timezone IANA name", () => {
    mocks.etcTimezone = "America/Los_Angeles\n";
    expect(detectOsTimezone()).toBe("America/Los_Angeles");
  });

  test("ignores a UTC /etc/timezone and falls through to the symlink", () => {
    mocks.etcTimezone = "UTC";
    mocks.localtimeLink = "/usr/share/zoneinfo/Europe/Berlin";
    expect(detectOsTimezone()).toBe("Europe/Berlin");
  });

  test("ignores an empty /etc/timezone and falls through to the symlink", () => {
    mocks.etcTimezone = "   \n";
    mocks.localtimeLink = "/var/db/timezone/zoneinfo/Asia/Tokyo";
    expect(detectOsTimezone()).toBe("Asia/Tokyo");
  });

  test("reads the IANA name from the /etc/localtime symlink target", () => {
    // /etc/timezone absent (throws) → symlink path.
    mocks.localtimeLink = "/usr/share/zoneinfo/America/New_York";
    expect(detectOsTimezone()).toBe("America/New_York");
  });

  test("returns null when the symlink target has no zoneinfo segment", () => {
    mocks.localtimeLink = "/some/other/path";
    expect(detectOsTimezone()).toBeNull();
  });

  test("returns null when the zoneinfo segment is empty", () => {
    mocks.localtimeLink = "/usr/share/zoneinfo/";
    expect(detectOsTimezone()).toBeNull();
  });

  test("returns null when neither source is available", () => {
    // Both /etc/timezone and /etc/localtime throw ENOENT.
    expect(detectOsTimezone()).toBeNull();
  });
});

describe("detectOsTimezone on Windows", () => {
  beforeEach(() => {
    setPlatform("win32");
  });

  test("maps a known Windows zone name to IANA", () => {
    mocks.tzutil = "Pacific Standard Time\r\n";
    expect(detectOsTimezone()).toBe("America/Los_Angeles");
  });

  test("returns null for an unmapped Windows zone name", () => {
    mocks.tzutil = "Some Obscure Standard Time";
    expect(detectOsTimezone()).toBeNull();
  });

  test("returns null when tzutil is unavailable", () => {
    mocks.tzutil = new Error("tzutil not on PATH");
    expect(detectOsTimezone()).toBeNull();
  });
});

describe("initTimezone applies a detected IANA zone", () => {
  const originalTz = process.env.TZ;

  beforeEach(() => {
    setPlatform("linux");
  });

  afterEach(() => {
    if (originalTz === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTz;
    }
  });

  test("sets TZ to the OS-detected zone when the runtime fell back to UTC", () => {
    delete process.env.TZ;
    // Runtime reports UTC ...
    vi.spyOn(Intl, "DateTimeFormat").mockReturnValue({
      resolvedOptions: () => ({ timeZone: "UTC" }),
    } as unknown as Intl.DateTimeFormat);
    // ... OS clock is elsewhere ...
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(480);
    // ... and the OS reports a concrete IANA zone.
    mocks.etcTimezone = "America/Los_Angeles";

    expect(initTimezone()).toBe("America/Los_Angeles");
    expect(process.env.TZ).toBe("America/Los_Angeles");
  });

  test("falls back to a fixed-offset zone when the OS zone is undetectable", () => {
    delete process.env.TZ;
    vi.spyOn(Intl, "DateTimeFormat").mockReturnValue({
      resolvedOptions: () => ({ timeZone: "UTC" }),
    } as unknown as Intl.DateTimeFormat);
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(480);
    // Neither /etc/timezone nor /etc/localtime resolves → fixed-offset path.
    expect(initTimezone()).toBe("Etc/GMT+8");
    expect(process.env.TZ).toBe("Etc/GMT+8");
  });

  test("returns null when detection yields UTC and the offset is sub-hour", () => {
    delete process.env.TZ;
    vi.spyOn(Intl, "DateTimeFormat").mockReturnValue({
      resolvedOptions: () => ({ timeZone: "UTC" }),
    } as unknown as Intl.DateTimeFormat);
    // 30-minute offset: osReportsNonUtc() is true, but detectOsTimezone()
    // returns null and fixedOffsetZone(30) is null → no repair applied.
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(30);
    expect(initTimezone()).toBeNull();
    expect(process.env.TZ).toBeUndefined();
  });
});
