import { describe, expect, it, vi } from "vitest";

import { configureWebPackPlugin } from "../../../../../src/lib/wizard/sourcemaps/tools/webpack.js";
import { createNewConfigFile } from "../../../../../src/lib/wizard/utils/clack/index.js";

vi.mock("@clack/prompts", () => ({
  log: { info: vi.fn(), success: vi.fn() },
}));
vi.mock("../../../../../src/lib/dsn/fs-utils.js", () => ({
  findFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock(
  "../../../../../src/lib/wizard/sourcemaps/utils/bundler-plugin.js",
  () => ({
    ensureBundlerPlugin: vi.fn().mockResolvedValue("@sentry/webpack-plugin"),
  }),
);
vi.mock("../../../../../src/lib/wizard/utils/clack/index.js", async () => ({
  ...(await vi.importActual(
    "../../../../../src/lib/wizard/utils/clack/index.js",
  )),
  addDotEnvSentryBuildPluginFile: vi.fn(),
  askForToolConfigPath: vi.fn().mockResolvedValue(undefined),
  createNewConfigFile: vi.fn().mockResolvedValue(true),
}));

describe("configureWebPackPlugin", () => {
  it("points to the webpack docs when it creates a new config", async () => {
    await configureWebPackPlugin({
      authToken: "",
      orgSlug: "my-org",
      projectSlug: "my-project",
      selfHosted: false,
      url: "https://sentry.io/",
    });

    expect(createNewConfigFile).toHaveBeenCalledWith(
      expect.stringContaining("webpack.config.js"),
      expect.any(String),
      expect.stringContaining("https://webpack.js.org/"),
    );
  });
});
