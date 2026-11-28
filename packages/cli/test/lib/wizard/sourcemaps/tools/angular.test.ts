import { describe, expect, it, vi } from "vitest";

import { configureAngularSourcemapGenerationFlow } from "../../../../../src/lib/wizard/sourcemaps/tools/angular.js";
import { clack } from "../../../../../src/lib/wizard/utils/clack/prompts.js";

describe("configureAngularSourcemapGenerationFlow", () => {
  it("shows sourceMap under the production configuration, like the automatic angular.json edit", async () => {
    vi.spyOn(clack.log, "info").mockImplementation(() => {});
    vi.spyOn(clack, "select").mockResolvedValue(true);
    const rawOutput = vi.spyOn(clack, "rawOutput").mockImplementation(() => {});

    await configureAngularSourcemapGenerationFlow();

    const snippet = rawOutput.mock.calls.map(([value]) => value).join("\n");
    expect(snippet).toMatch(
      /"configurations": \{\s*"production": \{[\s\S]*"sourceMap": true/,
    );
    expect(snippet).not.toContain('"options"');
  });
});
