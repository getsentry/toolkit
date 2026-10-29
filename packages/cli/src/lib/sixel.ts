/**
 * Terminal Graphics Support
 *
 * Detects whether the current terminal can render kitty or sixel graphics and,
 * if so, returns the baked banner (see {@link BANNER_IMAGE}) in the best
 * available format. Everything degrades gracefully to the block-art banner in
 * `banner.ts`.
 *
 * Detection uses a synchronous, best-effort terminal round-trip (unix only):
 *   - Primary Device Attributes (`ESC [ c`) — attribute `4` means sixel.
 *   - Text-area cell size (`ESC [ 16 t` → `ESC [ 6 ; H ; W t`) — used to check
 *     the fixed-pixel image actually fits the current column width.
 *   - Kitty graphics query (`ESC _ G ... a=q ... ESC \`) — an `OK` reply means
 *     the terminal speaks the newer kitty protocol, preferred over sixel.
 * The probe is gated behind an interactive TTY, honors plain-output/opt-out
 * signals, has a short timeout, restores terminal state, and never throws.
 * The result is cached for the process.
 *
 * Inside tmux, tmux answers DA1 and cell size itself, and swallows the bare
 * kitty query (stable tmux treats an APC string as a pane title). So under tmux
 * the kitty query is only sent through DCS passthrough when `allow-passthrough`
 * is enabled, and sixel is only trusted when tmux says the attached terminal
 * supports it too (otherwise tmux replaces the image with a text placeholder).
 */

import { execFileSync, execSync } from "node:child_process";
import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { BANNER_IMAGE } from "../generated/banner-image.js";
import { getOnOffPreference } from "./db/defaults.js";
import { getEnv } from "./env.js";
import { isPlainOutput, isTruthyEnv } from "./formatters/plain-detect.js";
import {
  kittyImageSequence,
  type TmuxKittyPlacement,
  wrapTmuxPassthrough,
} from "./kitty-image.js";
import { logger } from "./logger.js";
import { decodeImage, encodeImageToSixel } from "./sixel-image.js";

const log = logger.withTag("graphics");

/** Terminal graphics capabilities discovered by the probe. */
export type SixelCaps = {
  /** True when the terminal advertised sixel support (DA1 attribute 4). */
  supported: boolean;
  /**
   * True when the terminal advertised kitty graphics support (it answered the
   * graphics query with `OK`). Preferred over sixel when present.
   */
  kitty?: boolean;
  /** Character-cell width in pixels (from `CSI 16 t`), when reported. */
  cellWidth?: number;
  /** Character-cell height in pixels (from `CSI 16 t`), when reported. */
  cellHeight?: number;
  /**
   * True when kitty graphics were detected through tmux passthrough. Images
   * must then be wrapped for passthrough and drawn with Unicode placeholders.
   */
  tmux?: boolean;
};

/** Shared "no graphics" result. */
const UNSUPPORTED: SixelCaps = { supported: false };

/**
 * Fallback character-cell width in pixels, used when a graphics-capable
 * terminal doesn't report its cell size (`CSI 16 t`). Many kitty terminals
 * answer the graphics query but never report cell geometry; without a fallback
 * they would silently drop to ASCII rendering. 10×20 is a typical monospace
 * cell and keeps the rasterized dashboard reasonably proportioned.
 */
export const DEFAULT_CELL_WIDTH = 10;

/** Fallback character-cell height in pixels. See {@link DEFAULT_CELL_WIDTH}. */
export const DEFAULT_CELL_HEIGHT = 20;

/**
 * The terminal graphics protocol to use for inline images, ordered most capable
 * to least: kitty (direct RGBA, per-pixel alpha) is preferred over sixel
 * (palette-quantized). ASCII is the implicit fallback when neither is present.
 */
export type GraphicsFormat = "kitty" | "sixel";

/**
 * The graphics renderer requested by a dashboard invocation. A requested
 * protocol is preferred when available; otherwise selection falls back to the
 * normal automatic order (kitty, then sixel, then ASCII).
 */
export type GraphicsRendererPreference = "auto" | GraphicsFormat;

/** Select a graphics renderer from the protocols currently available. */
export function selectGraphicsFormatFromAvailability(
  preference: GraphicsRendererPreference,
  available: { kitty: boolean; sixel: boolean },
): GraphicsFormat | undefined {
  if (preference === "kitty" && available.kitty) {
    return "kitty";
  }
  if (preference === "sixel" && available.sixel) {
    return "sixel";
  }
  if (available.kitty) {
    return "kitty";
  }
  if (available.sixel) {
    return "sixel";
  }
  return;
}

/**
 * Pick the best available terminal graphics format, or `undefined` when the
 * terminal can only render ASCII. Kitty and sixel are usually mutually
 * exclusive, but when a terminal advertises both, kitty wins because it
 * transmits full RGBA without palette quantization.
 */
export function selectGraphicsFormat(
  preference: GraphicsRendererPreference = "auto",
): GraphicsFormat | undefined {
  return selectGraphicsFormatFromAvailability(preference, {
    kitty: canRenderKitty(),
    sixel: canRenderSixel(),
  });
}

/**
 * The character-cell dimensions in device pixels for the current terminal, or
 * `undefined` when no graphics format is available. Uses the terminal's
 * reported cell size when known and falls back to {@link DEFAULT_CELL_WIDTH} /
 * {@link DEFAULT_CELL_HEIGHT} otherwise, so a graphics-capable terminal that
 * never reports its geometry still renders graphics instead of ASCII.
 */
export function graphicsCellSize(
  preference: GraphicsRendererPreference = "auto",
): { cellWidth: number; cellHeight: number } | undefined {
  if (!selectGraphicsFormat(preference)) {
    return;
  }
  const caps = detectSixelCaps();
  return {
    cellWidth:
      caps.cellWidth && caps.cellWidth > 0
        ? caps.cellWidth
        : DEFAULT_CELL_WIDTH,
    cellHeight:
      caps.cellHeight && caps.cellHeight > 0
        ? caps.cellHeight
        : DEFAULT_CELL_HEIGHT,
  };
}

/** Primary DA reply: `ESC [ ? <p;p;...> c` — attribute list; `4` == sixel. */
// oxlint-disable-next-line no-control-regex -- parsing terminal escapes
const DA1_RE = /\x1b\[\?([0-9;]*)c/;

/** Cell-size report: `ESC [ 6 ; <height> ; <width> t`. */
// oxlint-disable-next-line no-control-regex -- parsing terminal escapes
const CELL_SIZE_RE = /\x1b\[6;(\d+);(\d+)t/;

/**
 * Timed-out reads (~300ms each) tolerated while waiting for the outer
 * terminal's replies through tmux passthrough; see {@link readReply}.
 */
const MAX_PASSTHROUGH_QUIET_READS = 4;

/** Every Primary DA reply in a buffer (tmux can produce two; see probe). */
// oxlint-disable-next-line no-control-regex -- parsing terminal escapes
const DA1_GLOBAL_RE = /\x1b\[\?[0-9;]*c/g;

/** Kitty graphics query reply: `ESC _ G i=<id>;OK ESC \`. */
// oxlint-disable-next-line no-control-regex -- parsing terminal escapes
const KITTY_RE = /\x1b_G[^\x1b]*;OK/;

/**
 * Kitty graphics query. Uploads a 1×1 RGB pixel (`f=24`) directly (`t=d`) with
 * `a=q` so the terminal only answers with support status and draws nothing. A
 * kitty-capable terminal replies `ESC _ G i=4271;OK ESC \`; others ignore it.
 * The id is deliberately not 31: tmux builds with kitty graphics support send
 * their own `i=31` query to the outer terminal and consume replies with that
 * id, so a passthrough reply with it could be swallowed.
 */
const KITTY_QUERY = "\x1b_Gi=4271,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\";

/** What tmux reports about the pane and the terminal it is attached to. */
export type TmuxInfo = {
  /** `allow-passthrough` is `on` or `all`, so DCS passthrough reaches the terminal. */
  passthrough: boolean;
  /** The attached terminal supports sixel, so tmux can redraw sixel images. */
  outerSixel: boolean;
};

/**
 * Parse `tmux display-message -p '#{allow-passthrough} #{client_termfeatures}'`.
 * Pure; exported for tests. An empty passthrough value (tmux older than 3.3,
 * which has no such option) is treated as disabled.
 * @internal
 */
export function parseTmuxInfo(output: string): TmuxInfo {
  const [passthrough = "", features = ""] = output.trim().split(" ");
  return {
    passthrough: passthrough === "on" || passthrough === "all",
    outerSixel: features.split(",").includes("sixel"),
  };
}

/**
 * Ask tmux about the current pane, or `undefined` when not running in tmux.
 * Failing to reach tmux means we can't route graphics through it, so that is
 * reported as no passthrough and no sixel.
 */
function detectTmux(): TmuxInfo | undefined {
  if (!getEnv().TMUX) {
    return;
  }
  try {
    const output = execFileSync(
      "tmux",
      ["display-message", "-p", "#{allow-passthrough} #{client_termfeatures}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1000 },
    );
    return parseTmuxInfo(output);
  } catch (error) {
    log.debug("Could not query tmux; disabling graphics passthrough", error);
    return { passthrough: false, outerSixel: false };
  }
}

/**
 * The probe queries to send, and how many Primary DA replies end the reply.
 *
 * Outside tmux the cell-size and kitty queries go first and DA1 last, so DA1 is
 * the drain sentinel. Inside tmux, tmux answers cell size and DA1 immediately,
 * while passthrough queries round-trip to the outer terminal; a second,
 * passthrough DA1 after the kitty query is the sentinel for that round-trip.
 * Without passthrough the kitty query is not sent at all, because tmux would
 * otherwise set the pane title to the query text.
 * @internal Exported for tests.
 */
export function probeQueries(tmux: TmuxInfo | undefined): {
  query: string;
  sentinels: number;
} {
  if (!tmux) {
    return { query: `\x1b[16t${KITTY_QUERY}\x1b[c`, sentinels: 1 };
  }
  if (!tmux.passthrough) {
    return { query: "\x1b[16t\x1b[c", sentinels: 1 };
  }
  return {
    query: `\x1b[16t\x1b[c${wrapTmuxPassthrough(`${KITTY_QUERY}\x1b[c`)}`,
    sentinels: 2,
  };
}

/**
 * Adjust parsed capabilities for tmux. tmux's own DA1 advertises sixel when it
 * was built with sixel support, regardless of the attached terminal, so sixel
 * also requires the attached terminal to support it. Kitty can only have been
 * detected through passthrough, so it is marked as needing tmux placement.
 * @internal Exported for tests.
 */
export function applyTmuxCaps(caps: SixelCaps, tmux: TmuxInfo): SixelCaps {
  const supported = caps.supported && tmux.outerSixel;
  if (!(supported || caps.kitty)) {
    return UNSUPPORTED;
  }
  const result: SixelCaps = { ...caps, supported };
  if (caps.kitty) {
    result.tmux = true;
  }
  return result;
}

let cached: SixelCaps | undefined;

/** Clear the cached probe result. Test-only. */
export function __resetSixelCache(): void {
  cached = undefined;
}

/**
 * Parse a terminal's reply to the DA1 + cell-size + kitty queries.
 *
 * Pure and side-effect free so it can be unit-tested without a terminal.
 * Returns {@link UNSUPPORTED} unless the first DA1 attribute list contains `4`
 * (sixel) or the terminal answered the kitty graphics query with `OK`. Under
 * tmux the first DA1 is tmux's own reply.
 */
export function parseSixelCaps(reply: string): SixelCaps {
  const da = reply.match(DA1_RE);
  const attrs = da?.[1]?.split(";") ?? [];
  const kitty = KITTY_RE.test(reply);
  if (!(attrs.includes("4") || kitty)) {
    return UNSUPPORTED;
  }
  const caps: SixelCaps = { supported: attrs.includes("4") };
  if (kitty) {
    caps.kitty = true;
  }
  const size = reply.match(CELL_SIZE_RE);
  if (size) {
    caps.cellHeight = Number(size[1]);
    caps.cellWidth = Number(size[2]);
  }
  return caps;
}

/**
 * Whether the fixed-pixel banner of `bannerWidth` px fits within `columns`
 * given the reported cell width. Requires a known cell width — if the terminal
 * didn't report one we can't guarantee the image won't overflow, so we decline.
 */
export function sixelFits(
  caps: SixelCaps,
  columns: number,
  bannerWidth: number,
): boolean {
  if (!(caps.supported && caps.cellWidth && caps.cellWidth > 0)) {
    return false;
  }
  return bannerWidth <= columns * caps.cellWidth;
}

/**
 * True when any signal says we must not probe/emit sixel. Exported for tests.
 * @internal
 */
export function optedOut(): boolean {
  // Use the isolation-aware env (matches isPlainOutput) so library/test runs
  // that call setEnv() see consistent TERM / SENTRY_NO_GRAPHICS values.
  const env = getEnv();
  return (
    !(process.stdout.isTTY && process.stdin.isTTY) ||
    process.platform === "win32" || // MVP: probe is unix-only
    isPlainOutput() ||
    !env.TERM ||
    env.TERM === "dumb" ||
    isTruthyEnv(env.SENTRY_NO_GRAPHICS ?? "") ||
    isTruthyEnv(env.SENTRY_NO_SIXEL ?? "")
  );
}

/**
 * Read the terminal's query replies from a blocking tty fd. With the tty in
 * `min 0 time N` mode each read blocks up to N deciseconds and returns 0 on
 * timeout.
 *
 * The queries are ordered so the Primary DA reply (which every terminal answers,
 * as `ESC [ ? … c`) arrives LAST — after the optional cell-size reply. So once a
 * complete DA reply is seen the whole reply has been drained, guaranteeing
 * nothing trails into the shell prompt even if the cell-size report lagged.
 *
 * Matching the full DA pattern (not merely any `c`) avoids stopping early on a
 * stray `c` — e.g. a keypress on `/dev/tty` during the probe. Exported for tests.
 *
 * Inside tmux with passthrough, tmux's own DA reply arrives at once but the
 * outer terminal's replies need a second round-trip, which can take longer
 * than one read timeout (e.g. over SSH). So once a DA reply has arrived and
 * more are expected, up to {@link MAX_PASSTHROUGH_QUIET_READS} timed-out reads
 * are tolerated before giving up.
 *
 * @param sentinels - Number of DA replies to wait for (2 inside tmux with
 *   passthrough: tmux's own, then the outer terminal's).
 * @param read - Reads into the buffer and returns the byte count; defaults to
 *   a blocking `readSync` on `fd`. Injectable for tests.
 * @internal
 */
export function readReply(
  fd: number,
  sentinels = 1,
  read: (buf: Buffer) => number = (buf) =>
    readSync(fd, buf, 0, buf.length, null),
): string {
  const buf = Buffer.alloc(256);
  let data = "";
  let quietReads = 0;
  for (let i = 0; i < 16; i++) {
    let n = 0;
    try {
      n = read(buf);
    } catch {
      break;
    }
    const received = data.match(DA1_GLOBAL_RE)?.length ?? 0;
    if (n <= 0) {
      quietReads += 1;
      const awaitingPassthrough = received > 0 && received < sentinels;
      if (!awaitingPassthrough || quietReads >= MAX_PASSTHROUGH_QUIET_READS) {
        break;
      }
      continue;
    }
    data += buf.toString("latin1", 0, n);
    // Stop only once every complete Primary DA (sentinel) reply has arrived.
    if ((data.match(DA1_GLOBAL_RE)?.length ?? 0) >= sentinels) {
      break;
    }
  }
  return data;
}

/**
 * Probe the terminal for sixel support. Synchronous, best-effort, unix-only.
 * Puts the tty in a timed raw read mode, emits the queries, parses the reply,
 * and always restores the prior tty state.
 *
 * Reads/writes a dedicated blocking `/dev/tty` fd rather than stdin (fd 0):
 * Node keeps stdin non-blocking, so a `readSync(0)` would return EAGAIN before
 * the terminal replies — leaving the reply to leak onto the shell prompt.
 */
function probe(): SixelCaps {
  if (optedOut()) {
    return UNSUPPORTED;
  }
  const tmux = detectTmux();
  let savedStty: string | undefined;
  let fd: number | undefined;
  // oxlint-disable-next-line sentry-cli/no-silent-catch -- grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    fd = openSync("/dev/tty", "r+");
    savedStty = execSync("stty -g < /dev/tty", { encoding: "utf8" }).trim();
    // min 0 time 3 => each read blocks up to ~300ms for (more) reply bytes.
    execSync("stty -echo -icanon min 0 time 3 < /dev/tty");
    const { query, sentinels } = probeQueries(tmux);
    writeSync(fd, query);
    const caps = parseSixelCaps(readReply(fd, sentinels));
    return tmux ? applyTmuxCaps(caps, tmux) : caps;
  } catch {
    return UNSUPPORTED;
  } finally {
    if (savedStty) {
      // oxlint-disable-next-line sentry-cli/no-silent-catch -- grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
      try {
        execSync(`stty ${savedStty} < /dev/tty`);
      } catch {
        // Best-effort restore; nothing actionable if it fails.
      }
    }
    if (fd !== undefined) {
      // oxlint-disable-next-line sentry-cli/no-silent-catch -- grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
      try {
        closeSync(fd);
      } catch {
        // Best-effort close.
      }
    }
  }
}

/** Cached terminal sixel capabilities (probes once per process). */
export function detectSixelCaps(): SixelCaps {
  if (!cached) {
    cached = probe();
  }
  return cached;
}

/**
 * True when the current terminal can display sixel graphics right now: it's an
 * interactive TTY, not opted out (plain-output / SENTRY_NO_GRAPHICS /
 * SENTRY_NO_SIXEL / non-unix), the persistent graphics=off default is not set,
 * and it advertised sixel support in the DA1 probe.
 *
 * Used by callers that render arbitrary images (not just the baked banner),
 * e.g. `sentry api` displaying image attachments inline.
 */
export function canRenderSixel(): boolean {
  if (optedOut()) {
    return false;
  }
  if (getOnOffPreference("graphics") === false) {
    return false;
  }
  return detectSixelCaps().supported;
}

/**
 * True when the current terminal can display kitty graphics right now: it's an
 * interactive TTY, not opted out (plain-output / SENTRY_NO_GRAPHICS /
 * SENTRY_NO_SIXEL / non-unix), the persistent graphics=off default is not set,
 * and it answered the kitty graphics query with `OK`. Newer terminals prefer
 * this protocol, so callers rendering arbitrary images (e.g. `sentry api`
 * attachments) check this before falling back to {@link canRenderSixel}.
 */
export function canRenderKitty(): boolean {
  if (optedOut()) {
    return false;
  }
  if (getOnOffPreference("graphics") === false) {
    return false;
  }
  return detectSixelCaps().kitty === true;
}

/**
 * The usable image width in device pixels for the current terminal — the
 * number of columns times the reported character-cell width. Returns
 * `undefined` when the terminal didn't report a cell width (in which case a
 * caller can't know the pixel budget and should fall back to a safe default).
 *
 * Callers rendering arbitrary images (e.g. `sentry api` attachments) use this
 * to downscale so a wide image doesn't overflow the terminal and garble the
 * session, mirroring the fit check {@link sixelFits} does for the banner.
 */
export function terminalPixelWidth(
  columns: number = process.stdout.columns ?? 80,
): number | undefined {
  const caps = detectSixelCaps();
  if (
    !((caps.supported || caps.kitty) && caps.cellWidth && caps.cellWidth > 0)
  ) {
    return;
  }
  return columns * caps.cellWidth;
}

/**
 * The usable image height in device pixels for a number of terminal rows.
 *
 * Returns `undefined` when the terminal did not report cell height. Callers
 * rendering positioned sixel layouts must require this measurement rather than
 * guessing, because a guessed row height corrupts the dashboard grid.
 */
export function terminalPixelHeight(
  rows: number = process.stdout.rows ?? 24,
): number | undefined {
  const caps = detectSixelCaps();
  if (
    !((caps.supported || caps.kitty) && caps.cellHeight && caps.cellHeight > 0)
  ) {
    return;
  }
  return rows * caps.cellHeight;
}

/**
 * Cell geometry for kitty output when kitty graphics were detected through
 * tmux, or `undefined` when kitty images can be written directly. Uses
 * {@link graphicsCellSize}, so an unreported cell size falls back to the
 * defaults: the terminal scales the image into the cell box, so a guess only
 * affects sharpness, never layout.
 */
export function tmuxKittyPlacement(
  columns: number = process.stdout.columns ?? 80,
): TmuxKittyPlacement | undefined {
  if (!detectSixelCaps().tmux) {
    return;
  }
  const cell = graphicsCellSize("kitty");
  return cell && { ...cell, maxColumns: columns };
}

/**
 * The baked banner as a kitty sequence. Inside tmux the banner is fitted into
 * the terminal width. Written directly it is shown at native pixel size, so it
 * needs the same fit check as sixel; graphics terminals that don't report
 * their cell size get {@link DEFAULT_CELL_WIDTH}.
 */
function kittyBanner(columns: number): string | undefined {
  const size = { width: BANNER_IMAGE.width, height: BANNER_IMAGE.height };
  const tmux = tmuxKittyPlacement(columns);
  if (tmux) {
    return kittyImageSequence("f=100", BANNER_IMAGE.png, size, tmux);
  }
  const cell = graphicsCellSize("kitty");
  if (!cell || BANNER_IMAGE.width > columns * cell.cellWidth) {
    return;
  }
  return kittyImageSequence("f=100", BANNER_IMAGE.png, size);
}

/** Sixel encoding of the banner, computed on first use. */
let cachedSixelBanner: string | undefined;

/** The baked banner PNG encoded as a sixel escape sequence. */
function sixelBanner(): string | undefined {
  if (cachedSixelBanner === undefined) {
    const image = decodeImage(Buffer.from(BANNER_IMAGE.png, "base64"), "png");
    cachedSixelBanner = image && encodeImageToSixel(image, image.width, true);
  }
  return cachedSixelBanner;
}

/**
 * The baked banner escape string in the best format the terminal supports
 * (kitty, then sixel) when it fits `columns`; otherwise `undefined` so the
 * caller falls back to the block-art banner.
 */
export function graphicsBanner(
  columns: number = process.stdout.columns ?? 80,
): string | undefined {
  // Re-evaluate the cheap, I/O-free gates on every call. detectSixelCaps caches
  // the probe result, so this ensures a later opt-out (NO_COLOR,
  // SENTRY_PLAIN_OUTPUT, SENTRY_NO_SIXEL, or a non-TTY stream) still suppresses
  // the image even if capabilities were cached as supported earlier.
  if (optedOut()) {
    return;
  }
  if (getOnOffPreference("graphics") === false) {
    return;
  }
  const format = selectGraphicsFormat();
  if (format === "kitty") {
    return kittyBanner(columns);
  }
  if (format === "sixel") {
    return sixelFits(detectSixelCaps(), columns, BANNER_IMAGE.width)
      ? sixelBanner()
      : undefined;
  }
  return;
}

/**
 * Terminal rows the {@link graphicsBanner} image occupies beyond the single
 * line of text its escape string takes, using the reported cell height or
 * {@link DEFAULT_CELL_HEIGHT} when the terminal did not report it. Inside tmux
 * the banner is drawn as lines of placeholder text, which callers already
 * count, so there are no extra rows.
 */
export function graphicsBannerExtraRows(): number {
  if (tmuxKittyPlacement()) {
    return 0;
  }
  const { cellHeight } = detectSixelCaps();
  const rowHeight =
    cellHeight && cellHeight > 0 ? cellHeight : DEFAULT_CELL_HEIGHT;
  return Math.ceil(BANNER_IMAGE.height / rowHeight) - 1;
}
