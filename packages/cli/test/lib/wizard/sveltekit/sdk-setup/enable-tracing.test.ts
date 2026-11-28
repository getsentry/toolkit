import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { showCopyPasteInstructionsMock } = vi.hoisted(() => ({
  showCopyPasteInstructionsMock: vi.fn(
    (_options: { filename: string; codeSnippet: string }) => Promise.resolve(),
  ),
}));

vi.mock("@clack/prompts", () => ({
  log: {
    info: vi.fn(),
    warning: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("../../../../../src/lib/error-reporting.js", () => ({
  reportCliError: vi.fn(),
}));

vi.mock("../../../../../src/lib/wizard/utils/clack/index.js", () => ({
  showCopyPasteInstructions: showCopyPasteInstructionsMock,
  makeCodeSnippet: (
    _colors: boolean,
    callback: (
      unchanged: (str: string) => string,
      plus: (str: string) => string,
    ) => string,
  ) =>
    callback(
      (str) => str,
      (str) => str,
    ),
}));

import { enableTracingAndInstrumentation } from "../../../../../src/lib/wizard/sveltekit/sdk-setup/svelte-config.js";

const configWith = (experimental: string) => `const config = {
  kit: {
    experimental: ${experimental},
  },
};

export default config;
`;

describe("enableTracingAndInstrumentation", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = mkdtempSync(path.join(tmpdir(), "sveltekit-config-test-"));
    configPath = path.join(tmpDir, "svelte.config.js");
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("turns on server options that are present but disabled", async () => {
    writeFileSync(
      configPath,
      configWith(
        "{ tracing: { server: false }, instrumentation: { server: true } }",
      ),
    );

    await enableTracingAndInstrumentation(
      {
        kit: {
          experimental: {
            tracing: { server: false },
            instrumentation: { server: true },
          },
        },
      },
      true,
    );

    const result = readFileSync(configPath, "utf-8");
    expect(result).toMatch(/tracing: \{\s*server: true/);
    expect(result).toMatch(/instrumentation: \{\s*server: true/);
    expect(showCopyPasteInstructionsMock).not.toHaveBeenCalled();
  });

  it("fills empty experimental objects", async () => {
    writeFileSync(
      configPath,
      configWith("{ tracing: {}, instrumentation: {} }"),
    );

    await enableTracingAndInstrumentation(
      { kit: { experimental: { tracing: {}, instrumentation: {} } } },
      true,
    );

    const result = readFileSync(configPath, "utf-8");
    expect(result).toMatch(/tracing: \{\s*server: true/);
    expect(result).toMatch(/instrumentation: \{\s*server: true/);
  });

  it("leaves a fully enabled config untouched", async () => {
    const content = configWith(
      "{ tracing: { server: true }, instrumentation: { server: true } }",
    );
    writeFileSync(configPath, content);

    await enableTracingAndInstrumentation(
      {
        kit: {
          experimental: {
            tracing: { server: true },
            instrumentation: { server: true },
          },
        },
      },
      true,
    );

    expect(readFileSync(configPath, "utf-8")).toBe(content);
  });

  it("keeps server tracing off in the fallback snippet when tracing was declined", async () => {
    writeFileSync(configPath, "export default {{{ not js");

    await enableTracingAndInstrumentation({}, false);

    expect(showCopyPasteInstructionsMock).toHaveBeenCalledTimes(1);
    const codeSnippet =
      showCopyPasteInstructionsMock.mock.calls[0]?.[0]?.codeSnippet ?? "";
    expect(codeSnippet).toMatch(/tracing: \{\s*server: false/);
    expect(codeSnippet).toMatch(/instrumentation: \{\s*server: true/);
  });
});
