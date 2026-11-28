import { describe, expect, it, vi } from "vitest";

import { detectUsedTool } from "../../../../../src/lib/wizard/sourcemaps/utils/detect-tool.js";
import { getPackageDotJson } from "../../../../../src/lib/wizard/utils/clack/index.js";

vi.mock("../../../../../src/lib/wizard/utils/clack/index.js", () => ({
  getPackageDotJson: vi.fn(),
}));

describe("detectUsedTool", () => {
  it("detects Create React App from react-scripts before TypeScript", async () => {
    vi.mocked(getPackageDotJson).mockResolvedValue({
      dependencies: { react: "^18.0.0", "react-scripts": "5.0.1" },
      devDependencies: { typescript: "^5.0.0" },
    });

    await expect(detectUsedTool()).resolves.toBe("create-react-app");
  });

  it("falls back to the generic flow", async () => {
    vi.mocked(getPackageDotJson).mockResolvedValue({});

    await expect(detectUsedTool()).resolves.toBe("sentry-cli");
  });
});
