import { describe, expect, it, vi } from "vitest";

import { configureCRASourcemapGenerationFlow } from "../../../../../src/lib/wizard/sourcemaps/tools/create-react-app.js";

const { selectMock } = vi.hoisted(() => ({
  selectMock: vi.fn().mockResolvedValue(true),
}));

vi.mock("@clack/prompts", () => ({
  select: selectMock,
  isCancel: vi.fn().mockReturnValue(false),
}));

describe("configureCRASourcemapGenerationFlow", () => {
  it("names the variable Create React App reads", async () => {
    await configureCRASourcemapGenerationFlow();

    const message = String(selectMock.mock.calls[0]?.[0]?.message);
    expect(message).toMatch(/\bGENERATE_SOURCEMAP\b/);
  });
});
