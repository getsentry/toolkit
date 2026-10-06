import { Writable } from "node:stream";
import { describe, expect, test } from "vitest";
import { createWizardSpinner } from "../../../src/lib/init/spinner.js";

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences in rendered terminal output
const ANSI_CSI_RE = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences in rendered terminal output
const ANSI_OSC_RE = /\u001B\][^\u0007]*\u0007/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI clear-screen escape sequence in rendered terminal output
const ANSI_CLEAR_RE = /\u001B\[(?:0)?J/;

class CaptureStream extends Writable {
  readonly chunks: string[] = [];
  readonly isTTY = true;
  readonly columns: number;

  constructor(columns = 80) {
    super();
    this.columns = columns;
  }

  _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.chunks.push(String(chunk));
    callback();
  }

  output(): string {
    return this.chunks.join("");
  }
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_CSI_RE, "").replace(ANSI_OSC_RE, "");
}

describe("createWizardSpinner", () => {
  test("clears upward when repainting a multiline status block", () => {
    const output = new CaptureStream();
    const spin = createWizardSpinner(output as unknown as NodeJS.WriteStream);

    spin.start("Reading files...\n├─ `settings.py`\n└─ `urls.py`");
    spin.message("Analyzing files...\n├─ `settings.py`\n└─ `urls.py`");
    spin.stop("Done");

    const rendered = output.output();
    expect(rendered).toContain("\u001B[?25l");
    expect(rendered).toContain("\u001B[2A");
    expect(rendered).toMatch(ANSI_CLEAR_RE);
    expect(rendered).toContain("\u001B[?25h");

    const plain = stripAnsi(rendered);
    expect(plain).toContain("Reading files...");
    expect(plain).toContain("│  ├─ settings.py");
    expect(plain).toContain("Analyzing files...");
  });

  test("does not print a stale message when stopped with an empty string", () => {
    const output = new CaptureStream();
    const spin = createWizardSpinner(output as unknown as NodeJS.WriteStream);

    spin.start("Selecting features");
    spin.stop("");

    const plain = stripAnsi(output.output());
    expect(plain).toContain("Selecting features");
    expect(plain).not.toContain("◆  Selecting features");
    expect(plain).not.toContain("■  Selecting features");
    expect(plain).not.toContain("▲  Selecting features");
  });
});
