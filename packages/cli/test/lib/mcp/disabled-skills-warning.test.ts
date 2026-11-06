import { afterEach, describe, expect, test, vi } from "vitest";
import { logger } from "../../../src/lib/logger.js";
import type { McpMergedArgs } from "../../../src/lib/mcp/args.js";
import { finalizeMcpConfig } from "../../../src/lib/mcp/config.js";
import { warnIneffectiveDisabledSkills } from "../../../src/lib/mcp/server.js";

function warningsFor(input: Partial<McpMergedArgs>): string[] {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  const log = vi.spyOn(console, "log");
  warnIneffectiveDisabledSkills(
    finalizeMcpConfig({ agentProviderFromFlag: false, ...input }),
  );
  // stdout carries the MCP transport, so nothing may be logged there.
  expect(log).not.toHaveBeenCalled();
  return warn.mock.calls.map((args) => String(args[0]));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("warnIneffectiveDisabledSkills", () => {
  test("warns when disabling docs leaves its tools enabled through inspect", () => {
    expect(warningsFor({ disableSkills: "docs" })).toEqual([
      'Disabling the "docs" skill removed no tools. get_doc, search_docs stay enabled through inspect.',
    ]);
  });

  test("stays silent when the disabled skill removes tools", () => {
    expect(warningsFor({ disableSkills: "seer" })).toEqual([]);
  });

  test("stays silent when inspect is disabled along with docs", () => {
    expect(warningsFor({ disableSkills: "docs,inspect" })).toEqual([]);
  });

  test("stays silent without --disable-skills", () => {
    expect(warningsFor({})).toEqual([]);
  });
});
