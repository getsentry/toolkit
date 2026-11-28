/**
 * Whether the terminal can print Unicode symbols such as `→`.
 *
 * Vendored from
 * https://github.com/sindresorhus/is-unicode-supported/blob/c80c691dde9e2fcfe3996810858c6672c8f35ad9/index.js#L3
 *
 * MIT License
 *
 * Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

import { getEnv } from "../../../env.js";

/** Whether the current terminal can render Unicode symbols. */
export function isUnicodeSupported(): boolean {
  const env = getEnv();
  if (process.platform !== "win32") {
    return env["TERM"] !== "linux"; // Linux console (kernel)
  }

  return (
    Boolean(env["CI"]) ||
    Boolean(env["WT_SESSION"]) || // Windows Terminal
    Boolean(env["TERMINUS_SUBLIME"]) || // Terminus (<0.2.27)
    env["ConEmuTask"] === "{cmd::Cmder}" || // ConEmu and cmder
    env["TERM_PROGRAM"] === "Terminus-Sublime" ||
    env["TERM_PROGRAM"] === "vscode" ||
    env["TERM"] === "xterm-256color" ||
    env["TERM"] === "alacritty" ||
    env["TERMINAL_EMULATOR"] === "JetBrains-JediTerm"
  );
}
