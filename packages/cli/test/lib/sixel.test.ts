/**
 * Sixel Banner Tests
 *
 * Covers the pure, terminal-independent pieces of sixel support: DA1/cell-size
 * reply parsing, fit calculation, the safe non-TTY default, and the shape of the
 * baked banner module. The terminal round-trip in `probe()` is intentionally not
 * exercised (it requires a real tty); everything it feeds is unit-tested here.
 */

import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert as fcAssert, integer, property, uniqueArray } from "fast-check";
import { afterEach, describe, expect, test } from "vitest";
import { BANNER_SIXEL } from "../../src/generated/banner-sixel.js";
import {
  __resetSixelCache,
  detectSixelCaps,
  graphicsCellSize,
  optedOut,
  parseSixelCaps,
  readReply,
  selectGraphicsFormat,
  selectGraphicsFormatFromAvailability,
  sixelBanner,
  sixelFits,
  terminalPixelWidth,
} from "../../src/lib/sixel.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

const ESC = "\x1b";

describe("parseSixelCaps", () => {
  test("detects sixel from DA1 attribute 4", () => {
    const caps = parseSixelCaps(`${ESC}[?62;4;6c`);
    expect(caps.supported).toBe(true);
  });

  test("treats missing attribute 4 as unsupported", () => {
    expect(parseSixelCaps(`${ESC}[?62;1;6c`).supported).toBe(false);
  });

  test("does not match 4 as a substring of another attribute", () => {
    // 14, 40, 64 all contain '4' but are not the sixel attribute.
    expect(parseSixelCaps(`${ESC}[?14;40;64c`).supported).toBe(false);
  });

  test("parses cell size from CSI 16 t report", () => {
    const caps = parseSixelCaps(`${ESC}[?62;4c${ESC}[6;20;10t`);
    expect(caps).toMatchObject({
      supported: true,
      cellHeight: 20,
      cellWidth: 10,
    });
  });

  test("supported but no cell size when 16t is absent", () => {
    const caps = parseSixelCaps(`${ESC}[?62;4c`);
    expect(caps.supported).toBe(true);
    expect(caps.cellWidth).toBeUndefined();
  });

  test("garbage / empty replies are unsupported", () => {
    expect(parseSixelCaps("").supported).toBe(false);
    expect(parseSixelCaps("not a terminal reply").supported).toBe(false);
  });

  test("property: supported iff the attribute list contains exactly '4'", () => {
    fcAssert(
      property(
        uniqueArray(integer({ min: 0, max: 99 }), { maxLength: 8 }),
        (attrs) => {
          const reply = `${ESC}[?${attrs.join(";")}c`;
          expect(parseSixelCaps(reply).supported).toBe(attrs.includes(4));
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("detects kitty support from an OK graphics reply", () => {
    const caps = parseSixelCaps(`${ESC}_Gi=31;OK${ESC}\\${ESC}[?62c`);
    expect(caps.kitty).toBe(true);
  });

  test("kitty support does not imply sixel support", () => {
    const caps = parseSixelCaps(`${ESC}_Gi=31;OK${ESC}\\${ESC}[?62c`);
    expect(caps.supported).toBe(false);
  });

  test("reports both when the terminal advertises sixel and kitty", () => {
    const caps = parseSixelCaps(`${ESC}_Gi=31;OK${ESC}\\${ESC}[?62;4c`);
    expect(caps).toMatchObject({ supported: true, kitty: true });
  });

  test("a kitty error reply is not treated as support", () => {
    const caps = parseSixelCaps(`${ESC}_Gi=31;ENOENT:bad${ESC}\\${ESC}[?62c`);
    expect(caps.kitty).toBeUndefined();
  });
});

describe("sixelFits", () => {
  const caps = { supported: true, cellWidth: 10, cellHeight: 20 };

  test("fits when banner width <= columns * cellWidth", () => {
    expect(sixelFits(caps, 80, 640)).toBe(true); // 800px available >= 640
    expect(sixelFits(caps, 64, 640)).toBe(true); // exactly 640px
  });

  test("does not fit when the image is wider than the terminal", () => {
    expect(sixelFits(caps, 60, 640)).toBe(false); // 600px < 640
  });

  test("declines without a known cell width", () => {
    expect(sixelFits({ supported: true }, 200, 640)).toBe(false);
    expect(sixelFits({ supported: true, cellWidth: 0 }, 200, 640)).toBe(false);
  });

  test("declines when unsupported", () => {
    expect(sixelFits({ supported: false, cellWidth: 10 }, 200, 640)).toBe(
      false
    );
  });
});

describe("terminalPixelWidth", () => {
  afterEach(() => {
    __resetSixelCache();
  });

  test("returns undefined when the terminal has no sixel caps (non-TTY test env)", () => {
    // Under the test runner stdin/stdout are not TTYs, so the probe reports
    // unsupported and there's no cell width to derive a pixel budget from.
    __resetSixelCache();
    expect(terminalPixelWidth(80)).toBeUndefined();
  });
});

describe("selectGraphicsFormat", () => {
  afterEach(() => {
    __resetSixelCache();
  });

  test("returns undefined in a non-interactive (test) environment", () => {
    // Under vitest stdin/stdout are not TTYs, so neither kitty nor sixel is
    // available and the caller falls back to ASCII.
    __resetSixelCache();
    expect(selectGraphicsFormat()).toBeUndefined();
  });

  test("falls back to the automatic renderer when the requested one is unavailable", () => {
    expect(
      selectGraphicsFormatFromAvailability("sixel", {
        kitty: true,
        sixel: false,
      })
    ).toBe("kitty");
  });
});

describe("graphicsCellSize", () => {
  afterEach(() => {
    __resetSixelCache();
  });

  test("returns undefined when no graphics format is available", () => {
    // No TTY in the test env means no graphics format, so no cell size either.
    __resetSixelCache();
    expect(graphicsCellSize()).toBeUndefined();
  });
});

describe("sixelBanner", () => {
  test("returns undefined in a non-interactive (test) environment", () => {
    // Under vitest stdin/stdout are not TTYs, so the probe opts out and no
    // sixel is emitted — the caller falls back to block art.
    expect(sixelBanner(200)).toBeUndefined();
  });

  test("suppresses the image when opted out even with a TTY", () => {
    const saved = {
      stdout: process.stdout.isTTY,
      stdin: process.stdin.isTTY,
      noSixel: process.env.SENTRY_NO_SIXEL,
    };
    try {
      // TTY on both ends, but SENTRY_NO_SIXEL forces opt-out: the emit-path
      // guard must return undefined without emitting (and without probing).
      process.stdout.isTTY = true;
      process.stdin.isTTY = true;
      process.env.SENTRY_NO_SIXEL = "1";
      __resetSixelCache();
      expect(sixelBanner(200)).toBeUndefined();
    } finally {
      process.stdout.isTTY = saved.stdout;
      process.stdin.isTTY = saved.stdin;
      if (saved.noSixel === undefined) {
        delete process.env.SENTRY_NO_SIXEL;
      } else {
        process.env.SENTRY_NO_SIXEL = saved.noSixel;
      }
      __resetSixelCache();
    }
  });
});

describe("BANNER_SIXEL (generated)", () => {
  test("is a well-formed sixel payload with positive dimensions", () => {
    expect(BANNER_SIXEL.width).toBeGreaterThan(0);
    expect(BANNER_SIXEL.height).toBeGreaterThan(0);
    // DCS sixel introducer ... String Terminator.
    expect(BANNER_SIXEL.data.startsWith(`${ESC}P`)).toBe(true);
    expect(BANNER_SIXEL.data.endsWith(`${ESC}\\`)).toBe(true);
    // Transparent background: P2 = 1 in the DCS parameters.
    expect(BANNER_SIXEL.data.startsWith(`${ESC}P0;1;0q`)).toBe(true);
  });
});

describe("optedOut", () => {
  const saved = {
    stdout: process.stdout.isTTY,
    stdin: process.stdin.isTTY,
    TERM: process.env.TERM,
    SENTRY_NO_SIXEL: process.env.SENTRY_NO_SIXEL,
    SENTRY_NO_GRAPHICS: process.env.SENTRY_NO_GRAPHICS,
    NO_COLOR: process.env.NO_COLOR,
    SENTRY_PLAIN_OUTPUT: process.env.SENTRY_PLAIN_OUTPUT,
    FORCE_COLOR: process.env.FORCE_COLOR,
  };

  const setEnv = (key: string, value: string | undefined): void => {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  };

  afterEach(() => {
    process.stdout.isTTY = saved.stdout;
    process.stdin.isTTY = saved.stdin;
    setEnv("TERM", saved.TERM);
    setEnv("SENTRY_NO_SIXEL", saved.SENTRY_NO_SIXEL);
    setEnv("SENTRY_NO_GRAPHICS", saved.SENTRY_NO_GRAPHICS);
    setEnv("NO_COLOR", saved.NO_COLOR);
    setEnv("SENTRY_PLAIN_OUTPUT", saved.SENTRY_PLAIN_OUTPUT);
    setEnv("FORCE_COLOR", saved.FORCE_COLOR);
  });

  /** Put the process in a state where sixel probing WOULD be allowed. */
  function makeInteractive(): void {
    process.stdout.isTTY = true;
    process.stdin.isTTY = true;
    setEnv("TERM", "xterm-256color");
    setEnv("SENTRY_NO_SIXEL", undefined);
    setEnv("NO_COLOR", undefined);
    setEnv("SENTRY_PLAIN_OUTPUT", undefined);
    setEnv("FORCE_COLOR", undefined);
  }

  test("does not opt out on an interactive color terminal (non-win32)", () => {
    makeInteractive();
    if (process.platform !== "win32") {
      expect(optedOut()).toBe(false);
    }
  });

  test("opts out when stdout or stdin is not a TTY", () => {
    makeInteractive();
    process.stdout.isTTY = false;
    expect(optedOut()).toBe(true);
    makeInteractive();
    process.stdin.isTTY = false;
    expect(optedOut()).toBe(true);
  });

  test("opts out when TERM is unset or dumb", () => {
    makeInteractive();
    setEnv("TERM", undefined);
    expect(optedOut()).toBe(true);
    makeInteractive();
    setEnv("TERM", "dumb");
    expect(optedOut()).toBe(true);
  });

  test("opts out under plain-output signals (NO_COLOR)", () => {
    makeInteractive();
    setEnv("NO_COLOR", "1");
    expect(optedOut()).toBe(true);
  });

  test("SENTRY_NO_SIXEL honors truthiness (0/false do not opt out)", () => {
    makeInteractive();
    setEnv("SENTRY_NO_SIXEL", "1");
    expect(optedOut()).toBe(true);
    makeInteractive();
    setEnv("SENTRY_NO_SIXEL", "0");
    if (process.platform !== "win32") {
      expect(optedOut()).toBe(false);
    }
    makeInteractive();
    setEnv("SENTRY_NO_SIXEL", "false");
    if (process.platform !== "win32") {
      expect(optedOut()).toBe(false);
    }
  });

  test("SENTRY_NO_GRAPHICS opts out", () => {
    setEnv("SENTRY_NO_GRAPHICS", "1");
    expect(optedOut()).toBe(true);
  });
});

describe("readReply", () => {
  function withReplyFile(bytes: string, fn: (fd: number) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "sixel-reply-"));
    const file = join(dir, "reply");
    writeFileSync(file, bytes, "latin1");
    const fd = openSync(file, "r");
    try {
      fn(fd);
    } finally {
      closeSync(fd);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("drains the full reply up to the Primary DA sentinel", () => {
    // Cell-size report first, Primary DA (sentinel, ends in `c`) last.
    withReplyFile(`${ESC}[6;20;10t${ESC}[?62;4;6c`, (fd) => {
      const reply = readReply(fd);
      expect(reply).toContain("c");
      expect(parseSixelCaps(reply)).toMatchObject({
        supported: true,
        cellHeight: 20,
        cellWidth: 10,
      });
    });
  });

  test("returns an empty string at EOF with no reply", () => {
    withReplyFile("", (fd) => {
      expect(readReply(fd)).toBe("");
    });
  });

  test("does not stop on a stray 'c' before the Primary DA reply", () => {
    // A stray `c` (e.g. a keypress) followed by the cell-size report but NO DA
    // reply: readReply must keep draining rather than stop at the stray `c`.
    withReplyFile(`c${ESC}[6;20;10t`, (fd) => {
      expect(readReply(fd)).toBe(`c${ESC}[6;20;10t`);
    });
  });

  test("captures the full reply even when preceded by a stray 'c'", () => {
    withReplyFile(`c${ESC}[6;20;10t${ESC}[?62;4;6c`, (fd) => {
      expect(parseSixelCaps(readReply(fd))).toMatchObject({
        supported: true,
        cellWidth: 10,
      });
    });
  });
});

describe("detectSixelCaps", () => {
  afterEach(() => {
    __resetSixelCache();
  });

  test("caches the probe result (unsupported in a non-TTY test env)", () => {
    __resetSixelCache();
    const first = detectSixelCaps();
    const second = detectSixelCaps();
    expect(first).toBe(second); // same cached reference — probed at most once
    expect(first.supported).toBe(false);
  });
});
