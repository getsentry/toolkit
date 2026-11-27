import { generateCode, type ProxifiedModule, parseModule } from "magicast";

import type { namedTypes as t } from "ast-types";

import {
  addSentrySerializerRequireToMetroConfig,
  addSentrySerializerToMetroConfig,
  findMetroConfigPath,
  getMetroConfigObject,
  patchMetroWithSentryConfigInMemory,
} from "../../../../src/lib/wizard/react-native/metro.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as fs from "node:fs";

vi.mock("../../../../src/lib/wizard/utils/clack/mcp-config.js", () => ({
  offerProjectScopedMcpConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("fs", async () => {
  const actual = await vi.importActual("fs");
  return {
    ...actual,
    existsSync: vi.fn(),
  };
});

describe("patch metro config - sentry serializer", () => {
  describe("patchMetroWithSentryConfigInMemory", () => {
    it("patches react native 0.72 default metro config", async () => {
      const mod =
        parseModule(`const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('metro-config').MetroConfig}
 */
const config = {};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);`);

      const result = await patchMetroWithSentryConfigInMemory(
        mod,
        "metro.config.js",
        true,
      );
      expect(result).toBe(true);
      expect(generateCode(mod.$ast).code)
        .toBe(`const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

const {
 withSentryConfig
} = require("@sentry/react-native/metro");

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('metro-config').MetroConfig}
 */
const config = {};

module.exports = withSentryConfig(mergeConfig(getDefaultConfig(__dirname), config));`);
    });

    it("patches react native 0.65 default metro config", async () => {
      const mod = parseModule(`/**
* Metro configuration for React Native
* https://github.com/facebook/react-native
*
* @format
*/

module.exports = {
  transformer: {
    getTransformOptions: async () => ({
      transform: {
        experimentalImportSupport: false,
        inlineRequires: true,
      },
    }),
  },
};`);

      const result = await patchMetroWithSentryConfigInMemory(
        mod,
        "metro.config.js",
        true,
      );
      expect(result).toBe(true);
      expect(generateCode(mod.$ast).code).toBe(`const {
  withSentryConfig
} = require("@sentry/react-native/metro");

/**
* Metro configuration for React Native
* https://github.com/facebook/react-native
*
* @format
*/

module.exports = withSentryConfig({
  transformer: {
    getTransformOptions: async () => ({
      transform: {
        experimentalImportSupport: false,
        inlineRequires: true,
      },
    }),
  },
});`);
    });

    it("patches react native metro config exported variable", async () => {
      const mod = parseModule(`const testConfig = {};

module.exports = testConfig;`);

      const result = await patchMetroWithSentryConfigInMemory(
        mod,
        "metro.config.js",
        true,
      );
      expect(result).toBe(true);
      expect(generateCode(mod.$ast).code).toBe(`const {
  withSentryConfig
} = require("@sentry/react-native/metro");

const testConfig = {};

module.exports = withSentryConfig(testConfig);`);
    });

    it("patches custom react native metro config", async () => {
      const mod =
        parseModule(`const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

const defaultConfig = getDefaultConfig(__dirname);
const {assetExts, sourceExts} = defaultConfig.resolver;
/**
 * Metro configuration
 * https://facebook.github.io/metro/docs/configuration
 *
 * @type {import('metro-config').MetroConfig}
 */

const jsoMetroPlugin = require('obfuscator-io-metro-plugin')(
  {
    // for these option look javascript-obfuscator library options from  above url
    compact: false,
    sourceMap: false,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 1,
    numbersToExpressions: true,
    simplify: true,
    stringArrayShuffle: true,
    splitStrings: true,
    stringArrayThreshold: 1,
  },
  {
    runInDev: false /* optional */,
    logObfuscatedFiles: true /* optional generated files will be located at ./.jso */,
    // source Map generated after obfuscation is not useful right now
    sourceMapLocation:
      './index.android.bundle.map' /* optional  only works if sourceMap: true in obfuscation option */,
  },
);

const config = {
  transformer: {
    babelTransformerPath: require.resolve('react-native-svg-transformer'),
    getTransformOptions: async () => ({
      transform: {
        experimentalImportSupport: false,
        inlineRequires: true,
      },
    }),
  },
  resolver: {
    assetExts: assetExts.filter(ext => ext !== 'svg'),
    sourceExts: [...sourceExts, 'svg'],
  },
  ...jsoMetroPlugin,
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);`);

      const result = await patchMetroWithSentryConfigInMemory(
        mod,
        "metro.config.js",
        true,
      );
      expect(result).toBe(true);
      expect(generateCode(mod.$ast).code)
        .toBe(`const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

const {
  withSentryConfig
} = require("@sentry/react-native/metro");

const defaultConfig = getDefaultConfig(__dirname);
const {assetExts, sourceExts} = defaultConfig.resolver;
/**
 * Metro configuration
 * https://facebook.github.io/metro/docs/configuration
 *
 * @type {import('metro-config').MetroConfig}
 */

const jsoMetroPlugin = require('obfuscator-io-metro-plugin')(
  {
    // for these option look javascript-obfuscator library options from  above url
    compact: false,
    sourceMap: false,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 1,
    numbersToExpressions: true,
    simplify: true,
    stringArrayShuffle: true,
    splitStrings: true,
    stringArrayThreshold: 1,
  },
  {
    runInDev: false /* optional */,
    logObfuscatedFiles: true /* optional generated files will be located at ./.jso */,
    // source Map generated after obfuscation is not useful right now
    sourceMapLocation:
      './index.android.bundle.map' /* optional  only works if sourceMap: true in obfuscation option */,
  },
);

const config = {
  transformer: {
    babelTransformerPath: require.resolve('react-native-svg-transformer'),
    getTransformOptions: async () => ({
      transform: {
        experimentalImportSupport: false,
        inlineRequires: true,
      },
    }),
  },
  resolver: {
    assetExts: assetExts.filter(ext => ext !== 'svg'),
    sourceExts: [...sourceExts, 'svg'],
  },
  ...jsoMetroPlugin,
};

module.exports = withSentryConfig(mergeConfig(getDefaultConfig(__dirname), config));`);
    });

    it("patches CJS style metro config", async () => {
      const mod =
        parseModule(`const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

const config = {};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);`);

      const result = await patchMetroWithSentryConfigInMemory(
        mod,
        "metro.config.cjs",
        true,
      );
      expect(result).toBe(true);

      const code = generateCode(mod.$ast).code;
      expect(code).toContain('require("@sentry/react-native/metro")');
      expect(code).toContain("withSentryConfig");
    });

    it("does not patch react native metro config exported as factory function", async () => {
      const mod = parseModule(`module.exports = () => ({});`);

      const result = await patchMetroWithSentryConfigInMemory(
        mod,
        "metro.config.js",
        true,
      );
      expect(result).toBe(false);
      expect(generateCode(mod.$ast).code).toBe(`module.exports = () => ({});`);
    });
  });

  describe("addSentrySerializerToMetroConfig", () => {
    it("add to empty config", () => {
      const mod = parseModule(`module.exports = {
        other: 'config'
      }`);
      const configObject = getModuleExportsObject(mod);
      const result = addSentrySerializerToMetroConfig(configObject);
      expect(result).toBe(true);
      expect(generateCode(mod.$ast).code).toBe(`module.exports = {
  other: 'config',

  serializer: {
    customSerializer: createSentryMetroSerializer()
  }
}`);
    });

    it("add to existing serializer config", () => {
      const mod = parseModule(`module.exports = {
  other: 'config',
  serializer: {
    other: 'config'
  }
}`);
      const configObject = getModuleExportsObject(mod);
      const result = addSentrySerializerToMetroConfig(configObject);
      expect(result).toBe(true);
      expect(generateCode(mod.$ast).code).toBe(`module.exports = {
  other: 'config',
  serializer: {
    other: 'config',
    customSerializer: createSentryMetroSerializer()
  }
}`);
    });

    it("not add to existing customSerializer config", () => {
      const mod = parseModule(`module.exports = {
  other: 'config',
  serializer: {
    other: 'config',
    customSerializer: 'existing-serializer'
  }
}`);
      const configObject = getModuleExportsObject(mod);
      const result = addSentrySerializerToMetroConfig(configObject);
      expect(result).toBe(false);
      expect(generateCode(mod.$ast).code).toBe(`module.exports = {
  other: 'config',
  serializer: {
    other: 'config',
    customSerializer: 'existing-serializer'
  }
}`);
    });
  });

  describe("addSentrySerializerImportToMetroConfig", () => {
    it("add import", () => {
      const mod =
        parseModule(`const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

module.exports = {
  other: 'config'
}`);
      const result = addSentrySerializerRequireToMetroConfig(
        mod.$ast as t.Program,
      );
      expect(result).toBe(true);
      expect(generateCode(mod.$ast).code)
        .toBe(`const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

const {
  createSentryMetroSerializer
} = require("@sentry/react-native/dist/js/tools/sentryMetroSerializer");

module.exports = {
  other: 'config'
}`);
    });
  });

  describe("getMetroConfigObject", () => {
    it("get config object from variable called config", () => {
      const mod = parseModule(`var config = { some: 'config' };`);
      const configObject = getMetroConfigObject(mod.$ast as t.Program);
      expect(configObject?.properties[0]).toMatchObject({
        key: { name: "some" },
        value: { value: "config" },
      });
    });

    it("get config object from const called config", () => {
      const mod = parseModule(`const config = { some: 'config' };`);
      const configObject = getMetroConfigObject(mod.$ast as t.Program);
      expect(configObject?.properties[0]).toMatchObject({
        key: { name: "some" },
        value: { value: "config" },
      });
    });

    it("get config oject from let called config", () => {
      const mod = parseModule(`let config = { some: 'config' };`);
      const configObject = getMetroConfigObject(mod.$ast as t.Program);
      expect(configObject?.properties[0]).toMatchObject({
        key: { name: "some" },
        value: { value: "config" },
      });
    });

    it("get config object from module.exports", () => {
      const mod = parseModule(`module.exports = { some: 'config' };`);
      const configObject = getMetroConfigObject(mod.$ast as t.Program);
      expect(configObject?.properties[0]).toMatchObject({
        key: { name: "some" },
        value: { value: "config" },
      });
    });
  });
});

describe("Dynamic Metro Config path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("finds metro.config.js when it exists", () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (path) => path === "metro.config.js",
    );

    const result = findMetroConfigPath();
    expect(result).toBe("metro.config.js");
  });

  it("finds metro.config.cjs when it exists", () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (path) => path === "metro.config.cjs",
    );

    const result = findMetroConfigPath();
    expect(result).toBe("metro.config.cjs");
  });

  it("prefers metro.config.js over metro.config.cjs when both exist", () => {
    vi.mocked(fs.existsSync).mockImplementation(() => true);

    const result = findMetroConfigPath();
    expect(result).toBe("metro.config.js");
  });

  it("returns undefined when no metro config exists", () => {
    vi.mocked(fs.existsSync).mockImplementation(() => false);

    const result = findMetroConfigPath();
    expect(result).toBeUndefined();
  });
});

function getModuleExportsObject(
  mod: ProxifiedModule,
  index = 0,
): t.ObjectExpression {
  return (
    ((mod.$ast as t.Program).body[index] as t.ExpressionStatement)
      .expression as t.AssignmentExpression
  ).right as t.ObjectExpression;
}
