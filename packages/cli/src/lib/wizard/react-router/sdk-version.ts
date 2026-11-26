import { getMajorVersion } from "../utils/semver.js";

/**
 * Version range of `@sentry/react-router` (and `@sentry/profiling-node`) the
 * wizard installs. Also decides the default import path of the Vite plugin
 * helpers when the installed version is unknown.
 */
export const SENTRY_REACT_ROUTER_SDK_RANGE = "^11";

/** Root export. Exposes `sentryReactRouter` and `sentryOnBuildEnd` up to SDK v10 only. */
export const SENTRY_REACT_ROUTER_ROOT_IMPORT_PATH = "@sentry/react-router";

/** Subpath that exposes the Vite plugin helpers from SDK v11 on. v10 does not ship it. */
export const SENTRY_REACT_ROUTER_VITE_IMPORT_PATH = "@sentry/react-router/vite";

/** Minimum React Router version supported by SDK v11 in framework mode. */
export const MIN_REACT_ROUTER_VERSION_FOR_SDK_V11 = "7.15.0";

/**
 * Returns the module `sentryReactRouter` and `sentryOnBuildEnd` must be
 * imported from for the installed SDK. v11 moved them to the `/vite` subpath
 * and removed them from the root export, while v10 only has them on the root
 * export. Unknown or unparseable versions fall back to whatever the wizard
 * would install.
 */
export function getSentryReactRouterVitePluginImportPath(
  installedSdkVersion: string | undefined,
): string {
  const sdkMajor =
    getMajorVersion(installedSdkVersion) ??
    getMajorVersion(SENTRY_REACT_ROUTER_SDK_RANGE) ??
    0;

  return sdkMajor >= 11
    ? SENTRY_REACT_ROUTER_VITE_IMPORT_PATH
    : SENTRY_REACT_ROUTER_ROOT_IMPORT_PATH;
}
