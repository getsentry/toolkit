/**
 * Terminal color utilities using Sentinel-inspired palette
 *
 * Provides consistent coloring for CLI output with semantic helpers.
 */

import chalk from "chalk";
import type { IssueLevel, IssueStatus } from "../../types/index.js";
import { isPlainOutput } from "./plain-detect.js";

// Color Palette (Full Sentinel palette)

export const COLORS = {
  red: "#fe4144",
  green: "#83da90",
  yellow: "#FDB81B",
  blue: "#226DFC",
  magenta: "#FF45A8",
  white: "#f9f8f9",
  cyan: "#79B8FF",
  muted: "#898294",
  /** Background tint for inline code spans (dark teal, pairs with cyan text) */
  codeBg: "#1a2f3a",
  /** Foreground color for inline code spans */
  codeFg: "#22d3ee",
} as const;

// Base Color Functions

export const red = (text: string): string => chalk.hex(COLORS.red)(text);
export const green = (text: string): string => chalk.hex(COLORS.green)(text);
export const yellow = (text: string): string => chalk.hex(COLORS.yellow)(text);
export const blue = (text: string): string => chalk.hex(COLORS.blue)(text);
export const magenta = (text: string): string =>
  chalk.hex(COLORS.magenta)(text);
export const white = (text: string): string => chalk.hex(COLORS.white)(text);
export const cyan = (text: string): string => chalk.hex(COLORS.cyan)(text);
export const muted = (text: string): string => chalk.hex(COLORS.muted)(text);
export const bold = (text: string): string => chalk.bold(text);
export const underline = (text: string): string => chalk.underline(text);
export const boldUnderline = (text: string): string =>
  chalk.bold.underline(text);

/**
 * Wrap text in an OSC 8 terminal hyperlink.
 *
 * On terminals that support OSC 8 (iTerm2, Windows Terminal, VS Code,
 * most modern emulators), the text becomes clickable. On terminals that
 * don't, the escape sequences are silently ignored and the text renders
 * normally.
 *
 * `string-width` treats OSC 8 sequences as zero-width, so column sizing
 * in tables is not affected.
 *
 * @param text - Display text (also used as the link target when `url` is omitted)
 * @param url - Target URL. Defaults to `text`, which is convenient when the
 *   display text is already the full URL.
 * @returns Text wrapped in OSC 8 hyperlink escape sequences
 */
export function terminalLink(text: string, url: string = text): string {
  if (isPlainOutput()) {
    return text;
  }
  // OSC 8 ; params ; URI BEL  text  OSC 8 ; ; BEL
  // \x1b] opens the OSC sequence; \x07 (BEL) terminates it.
  // Using BEL instead of ST (\x1b\\) for broad terminal compatibility.
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

// Semantic Helpers

/** Format success messages (green) */
export const success = (text: string): string => green(text);

/** Format error messages (red) */
export const error = (text: string): string => red(text);

/** Format warning messages (yellow) */
export const warning = (text: string): string => yellow(text);

/** Format info messages (cyan) */
export const info = (text: string): string => cyan(text);

/** Format headers and dividers (muted) */
export const header = (text: string): string => muted(text);

// Status-based Coloring

const STATUS_COLORS: Record<IssueStatus, (text: string) => string> = {
  resolved: green,
  resolvedInNextRelease: green,
  unresolved: yellow,
  ignored: muted,
  muted,
};

/**
 * Color text based on issue status (case-insensitive)
 */
export function statusColor(text: string, status: string | undefined): string {
  // Try exact match first (handles camelCase like resolvedInNextRelease),
  // then fall back to lowercase (handles unexpected uppercase from older instances).
  const colorFn =
    STATUS_COLORS[status as IssueStatus] ??
    STATUS_COLORS[status?.toLowerCase() as IssueStatus] ??
    STATUS_COLORS.unresolved;
  return colorFn(text);
}

// Level-based Coloring

const LEVEL_COLORS: Record<IssueLevel, (text: string) => string> = {
  fatal: red,
  error: red,
  warning: yellow,
  info: cyan,
  debug: muted,
};

/**
 * Color text based on issue level (case-insensitive)
 */
export function levelColor(text: string, level: string | undefined): string {
  const normalizedLevel = level?.toLowerCase() as IssueLevel;
  const colorFn = LEVEL_COLORS[normalizedLevel];
  return colorFn ? colorFn(text) : text;
}

// Fixability-based Coloring

/** Fixability tier labels returned by getSeerFixabilityLabel() */
export type FixabilityTier = "high" | "med" | "low";

const FIXABILITY_COLORS: Record<FixabilityTier, (text: string) => string> = {
  high: green,
  med: yellow,
  low: red,
};

/**
 * Color text based on Seer fixability tier.
 *
 * @param text - Text to colorize
 * @param tier - Fixability tier label (`"high"`, `"med"`, or `"low"`)
 */
export function fixabilityColor(text: string, tier: FixabilityTier): string {
  return FIXABILITY_COLORS[tier](text);
}
