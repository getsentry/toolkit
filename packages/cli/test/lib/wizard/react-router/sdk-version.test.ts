import { describe, expect, it } from "vitest";
import {
  getSentryReactRouterVitePluginImportPath,
  SENTRY_REACT_ROUTER_SDK_RANGE,
  getProfilingNodeRange,
} from "../../../../src/lib/wizard/react-router/sdk-version.js";

describe("getSentryReactRouterVitePluginImportPath", () => {
  it.each(["11.0.0", "^11.0.0", "11.0.0-beta.2", "~11.2.0", "12.0.0"])(
    "returns the /vite subpath for SDK %s",
    (version) => {
      expect(getSentryReactRouterVitePluginImportPath(version)).toBe(
        "@sentry/react-router/vite",
      );
    },
  );

  it.each(["10.74.0", "^10.0.0", "~10.73.0", "9.47.1"])(
    "returns the root export for SDK %s",
    (version) => {
      expect(getSentryReactRouterVitePluginImportPath(version)).toBe(
        "@sentry/react-router",
      );
    },
  );

  it.each([undefined, "", "latest", "workspace:*"])(
    "falls back to the pinned install range when the version is unknown (%s)",
    (version) => {
      expect(getSentryReactRouterVitePluginImportPath(version)).toBe(
        getSentryReactRouterVitePluginImportPath(SENTRY_REACT_ROUTER_SDK_RANGE),
      );
    },
  );
});

describe("getProfilingNodeRange", () => {
  it.each([
    ["^10.20.0", "^10"],
    ["10.5.1", "^10"],
    ["^11.0.0", "^11"],
    [undefined, "^11"],
    ["workspace:*", "^11"],
  ])("matches the installed SDK %s with %s", (installed, expected) => {
    expect(getProfilingNodeRange(installed)).toBe(expected);
  });
});
