import { describe, expect, it, vi } from "vitest";

import { buildOutroMessage } from "../../../../src/lib/wizard/nuxt/nuxt-wizard.js";

vi.mock("../../../../src/lib/wizard/utils/clack/mcp-config.js", () => ({
  offerProjectScopedMcpConfig: vi.fn().mockResolvedValue(undefined),
}));

describe("buildOutroMessage", () => {
  it("names the SentryErrorButton component the wizard creates", () => {
    const message = buildOutroMessage(false, true);
    expect(message).toContain("`SentryErrorButton`");
    expect(message).not.toContain("SentryExampleButton");
  });

  it("points to the example page when one was created", () => {
    const message = buildOutroMessage(true, false);
    expect(message).toContain('"/sentry-example-page"');
    expect(message).not.toContain("SentryErrorButton");
  });
});
