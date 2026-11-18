/**
 * Strip ANSI/VT escape sequences from a string.
 *
 * Browser-safe: CLI human output and the Local viewer share it.
 *
 * Covers the four escape-sequence families that can reach a terminal:
 *   - CSI (`\x1b[`): SGR colour codes, cursor movement, screen-clear, etc.
 *   - OSC (`\x1b]`): window-title changes, hyperlinks, etc.
 *   - DCS (`\x1bP`): device-control strings.
 *   - Two-character C1 ESC: single-byte sequences like `\x1bc` (terminal reset).
 */
export function stripAnsi(text: string): string {
  return (
    text
      // CSI: \x1b[ + param bytes (0x30-0x3F) + intermediate bytes (0x20-0x2F) + final byte (0x40-0x7E)
      // oxlint-disable-next-line no-control-regex -- ANSI escape detection requires matching \x1b
      .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, "")
      // OSC: \x1b] ... terminated by BEL (\x07) or ST (\x1b\)
      // oxlint-disable-next-line no-control-regex -- OSC sequences use \x1b and \x07
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      // DCS: \x1bP ... terminated by ST (\x1b\)
      // oxlint-disable-next-line no-control-regex -- DCS sequences use \x1b
      .replace(/\x1bP[^\x1b]*\x1b\\/g, "")
      // Two-character ESC sequences (C1: 0x40-0x5F, Fs: 0x60-0x7E), e.g. \x1bc (terminal reset).
      // Applied last so CSI/OSC/DCS introducers (\x1b[, \x1b], \x1bP) are already stripped.
      // oxlint-disable-next-line no-control-regex -- ESC sequence detection requires matching \x1b
      .replace(/\x1b[@-~]/g, "")
  );
}
