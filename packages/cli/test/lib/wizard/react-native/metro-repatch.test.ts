import { generateCode, parseModule } from "magicast";
import { describe, expect, it, vi } from "vitest";
import { patchMetroWithSentryConfigInMemory } from "../../../../src/lib/wizard/react-native/metro.js";

vi.mock("@clack/prompts", () => ({
  select: vi.fn().mockResolvedValue(true),
  isCancel: () => false,
  log: { success: vi.fn(), warn: vi.fn(), step: vi.fn() },
}));

describe("patchMetroWithSentryConfigInMemory on a config that already has Sentry", () => {
  it("does not add a second withSentryConfig binding or wrap", async () => {
    const mod =
      parseModule(`const { getDefaultConfig } = require('@react-native/metro-config');
const { withSentryConfig } = require('@sentry/react-native/metro');

const config = getDefaultConfig(__dirname);
module.exports = withSentryConfig(config);
`);

    const patched = await patchMetroWithSentryConfigInMemory(
      mod,
      "metro.config.js",
      true,
    );
    const code = generateCode(mod.$ast).code;

    expect(patched).toBe(true);
    expect(() => parseModule(code)).not.toThrow();
    expect(code.match(/const \{\s*withSentryConfig\s*\}/g)).toHaveLength(1);
    expect(code.match(/withSentryConfig\(/g)).toHaveLength(1);
  });
});
