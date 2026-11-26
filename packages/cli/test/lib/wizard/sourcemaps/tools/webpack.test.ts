import fs from "node:fs";

import { modifyWebpackConfig } from "../../../../../src/lib/wizard/sourcemaps/tools/webpack.js";

import { vi, it, expect, describe, afterEach } from "vitest";

function updateFileContent(content: string): void {
  fileContent = content;
}

let fileContent = "";

vi.mock("@clack/prompts", () => {
  return {
    log: {
      info: vi.fn(),
      success: vi.fn(),
    },
    select: vi.fn().mockImplementation(() => Promise.resolve(true)),
    isCancel: vi.fn().mockReturnValue(false),
  };
});

vi.spyOn(fs.promises, "readFile").mockImplementation(() =>
  Promise.resolve(fileContent),
);

const writeFileSpy = vi
  .spyOn(fs.promises, "writeFile")
  .mockImplementation(() => Promise.resolve(void 0));

const noSourcemapNoPluginsPojo = `module.exports = {
  entry: "./src/index.js",
  output: {
    filename: "main.js",
    path: path.resolve(__dirname, "build"),
  },
};`;

const noSourcemapNoPluginsPojoResult = `const {
  sentryWebpackPlugin
} = require("@sentry/bundler-plugins/webpack");

module.exports = {
  entry: "./src/index.js",

  output: {
    filename: "main.js",
    path: path.resolve(__dirname, "build"),
  },

  devtool: "source-map",

  plugins: [sentryWebpackPlugin({
    authToken: process.env.SENTRY_AUTH_TOKEN,
    org: "my-org",
    project: "my-project"
  })]
};`;

const noSourcemapsNoPluginsId = `const config = {
  entry: "./src/index.js",

  output: {
    filename: "main.js",
    path: path.resolve(__dirname, "build"),
  },
};

module.exports = config;`;

const noSourcemapsNoPluginsIdResult = `const {
  sentryWebpackPlugin
} = require("@sentry/bundler-plugins/webpack");

const config = {
  entry: "./src/index.js",

  output: {
    filename: "main.js",
    path: path.resolve(__dirname, "build"),
  },

  devtool: "source-map",

  plugins: [sentryWebpackPlugin({
    authToken: process.env.SENTRY_AUTH_TOKEN,
    org: "my-org",
    project: "my-project"
  })]
};

module.exports = config;`;

const hiddenSourcemapNoPluginsId = `const config = {
  entry: "./src/index.js",

  output: {
    filename: "main.js",
    path: path.resolve(__dirname, "build"),
  },

  devtool: "hidden-cheap-source-map",
};

module.exports = config;
    `;
const hiddenSourcemapNoPluginsIdResult = `const {
  sentryWebpackPlugin
} = require("@sentry/bundler-plugins/webpack");

const config = {
  entry: "./src/index.js",

  output: {
    filename: "main.js",
    path: path.resolve(__dirname, "build"),
  },

  devtool: "hidden-source-map",

  plugins: [sentryWebpackPlugin({
    authToken: process.env.SENTRY_AUTH_TOKEN,
    org: "my-org",
    project: "my-project"
  })]
};

module.exports = config;`;

const arbitrarySourcemapNoPluginsId = `
const config = {
  entry: "./src/index.js",

  output: {
    filename: "main.js",
    path: path.resolve(__dirname, "build"),
  },

  devtool: getSourcemapSetting(),
};

module.exports = config;
    `;
const arbitrarySourcemapNoPluginsIdResult = `const {
  sentryWebpackPlugin
} = require("@sentry/bundler-plugins/webpack");

const config = {
  entry: "./src/index.js",

  output: {
    filename: "main.js",
    path: path.resolve(__dirname, "build"),
  },

  devtool: "source-map",

  plugins: [sentryWebpackPlugin({
    authToken: process.env.SENTRY_AUTH_TOKEN,
    org: "my-org",
    project: "my-project"
  })]
};

module.exports = config;`;

const noSourcemapUndefinedPluginsPojo = `module.exports = {
  entry: "./src/index.js",
  plugins: undefined,
  output: {
    filename: "main.js",
    path: path.resolve(__dirname, "build"),
  },
};`;

const noSourcemapUndefinedPluginsPojoResult = `const {
  sentryWebpackPlugin
} = require("@sentry/bundler-plugins/webpack");

module.exports = {
  entry: "./src/index.js",

  plugins: [sentryWebpackPlugin({
    authToken: process.env.SENTRY_AUTH_TOKEN,
    org: "my-org",
    project: "my-project"
  })],

  output: {
    filename: "main.js",
    path: path.resolve(__dirname, "build"),
  },

  devtool: "source-map"
};`;

const noSourcemapPluginsPojo = `module.exports = {
  entry: "./src/index.js",
  plugins: [
    new HtmlWebpackPlugin(),
    new MiniCssExtractPlugin(),
  ],
  output: {
    filename: "main.js",
    path: path.resolve(__dirname, "build"),
  },
};`;

const noSourcemapPluginsPojoResult = `const {
  sentryWebpackPlugin
} = require("@sentry/bundler-plugins/webpack");

module.exports = {
  entry: "./src/index.js",

  plugins: [new HtmlWebpackPlugin(), new MiniCssExtractPlugin(), sentryWebpackPlugin({
    authToken: process.env.SENTRY_AUTH_TOKEN,
    org: "my-org",
    project: "my-project"
  })],

  output: {
    filename: "main.js",
    path: path.resolve(__dirname, "build"),
  },

  devtool: "source-map"
};`;

describe("modifyWebpackConfig", () => {
  afterEach(() => {
    fileContent = "";
    vi.clearAllMocks();
  });

  it.each([
    [
      "no sourcemap option, no plugins, object",
      noSourcemapNoPluginsPojo,
      noSourcemapNoPluginsPojoResult,
    ],
    [
      "no sourcemap option, no plugins, identifier",
      noSourcemapsNoPluginsId,
      noSourcemapsNoPluginsIdResult,
    ],
    [
      "hidden sourcemap option, no plugins, identifier",
      hiddenSourcemapNoPluginsId,
      hiddenSourcemapNoPluginsIdResult,
    ],
    [
      "arbitrary sourcemap option, no plugins, identifier",
      arbitrarySourcemapNoPluginsId,
      arbitrarySourcemapNoPluginsIdResult,
    ],
    [
      "no sourcemap option, plugins, object",
      noSourcemapUndefinedPluginsPojo,
      noSourcemapUndefinedPluginsPojoResult,
    ],
    [
      "no sourcemap option, plugins, object",
      noSourcemapPluginsPojo,
      noSourcemapPluginsPojoResult,
    ],
  ])(
    "adds plugin and source maps emission to the webpack config (%s)",
    async (_, originalCode, expectedCode) => {
      updateFileContent(originalCode);

      //   updateFileContent(originalCode);
      const addedCode = await modifyWebpackConfig(
        "",
        {
          authToken: "",
          orgSlug: "my-org",
          projectSlug: "my-project",
          selfHosted: false,
          url: "https://sentry.io/",
        },
        "@sentry/bundler-plugins/webpack",
      );

      expect(writeFileSpy).toHaveBeenCalledTimes(1);
      const fileContent = writeFileSpy.mock.calls[0]?.[1];
      expect(fileContent).toBe(expectedCode);
      expect(addedCode).toBe(true);
    },
  );

  it("adds the url parameter to the webpack plugin options if self-hosted", async () => {
    updateFileContent(noSourcemapNoPluginsPojo);

    const addedCode = await modifyWebpackConfig(
      "",
      {
        authToken: "",
        orgSlug: "my-org",
        projectSlug: "my-project",
        selfHosted: true,
        url: "https://santry.io/",
      },
      "@sentry/bundler-plugins/webpack",
    );

    expect(writeFileSpy).toHaveBeenCalledTimes(1);
    const fileContent = writeFileSpy.mock.calls[0]?.[1];
    expect(fileContent).toContain('url: "https://santry.io/"');
    expect(addedCode).toBe(true);
  });
});
