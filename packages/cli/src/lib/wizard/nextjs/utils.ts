/**
 * Helpers of the Next.js wizard: SDK versions, project layout, and
 * config-file detection.
 */

import { existsSync, lstatSync } from "node:fs";
import path from "node:path";
import { lt, major, minVersion } from "semver";
import { type ASTNode, builders, type ProxifiedModule } from "magicast";
import {
  SENTRY_NEXTJS_CONFIG_IMPORT_PATH,
  SENTRY_NEXTJS_ROOT_IMPORT_PATH,
  type ExampleApiRouteDynamicStrategy,
} from "./templates.js";
import { debug } from "../utils/debug.js";

/** First `@sentry/nextjs` release that exposes `withSentryConfig` on the `/config` subpath. */
export const MIN_SDK_VERSION_WITH_CONFIG_SUBPATH = "10.73.0";

/**
 * Returns the module `withSentryConfig` should be imported from for the
 * installed SDK version. The wizard installs `^11`, but a user can keep an
 * older SDK by declining the update prompt. Those releases only expose
 * `withSentryConfig` on the root export, so fall back to it there. Unknown or
 * unparseable versions get the subpath, which is the only option on v11.
 */
export function getWithSentryConfigImportPath(
  sdkVersion: string | undefined,
): string {
  if (!sdkVersion) {
    return SENTRY_NEXTJS_CONFIG_IMPORT_PATH;
  }

  try {
    const minVer = minVersion(sdkVersion);
    if (minVer && lt(minVer, MIN_SDK_VERSION_WITH_CONFIG_SUBPATH)) {
      return SENTRY_NEXTJS_ROOT_IMPORT_PATH;
    }
  } catch (error) {
    debug(error);
    // fall through
  }

  return SENTRY_NEXTJS_CONFIG_IMPORT_PATH;
}

/** Minimum Next.js major supported by the Sentry Next.js SDK (v11 dropped Next.js 13). */
export const MIN_SUPPORTED_NEXTJS_MAJOR = 14;

/**
 * Returns `false` when the given Next.js version range is definitely below the
 * minimum the SDK supports. Unknown or unparseable versions are treated as supported.
 */
export function isNextJsVersionSupported(version: string | undefined): boolean {
  if (!version) {
    return true;
  }

  try {
    const minVer = minVersion(version);
    if (!minVer) {
      return true;
    }
    return major(minVer) >= MIN_SUPPORTED_NEXTJS_MAJOR;
  } catch (error) {
    debug(error);
    return true;
  }
}

/**
 * Picks how the generated example API route opts out of static rendering.
 * Next.js 14 caches GET route handlers by default, so the route needs
 * `export const dynamic = "force-dynamic"` or the build evaluates (and fails on)
 * the throwing handler. Next.js 15+ ships `connection()` from `next/server`,
 * which also works on Next.js 16 with `cacheComponents`, where route segment
 * config is rejected. Unknown versions keep the previous `force-dynamic` behavior.
 */
export function getExampleApiRouteDynamicStrategy(
  version: string | undefined,
): ExampleApiRouteDynamicStrategy {
  if (!version) {
    return "force-dynamic";
  }

  try {
    const minVer = minVersion(version);
    if (!minVer) {
      return "force-dynamic";
    }
    return major(minVer) >= 15 ? "connection" : "force-dynamic";
  } catch (error) {
    debug(error);
    return "force-dynamic";
  }
}

/**
 * Adds `import { withSentryConfig } from <importPath>` to the module.
 * If the module already imports `withSentryConfig` (e.g. from the root
 * `@sentry/nextjs` export used by SDK v10 and earlier), the existing import is
 * rewritten to the given path instead of adding a duplicate binding.
 */
export function addWithSentryConfigImport(
  mod: ProxifiedModule,
  importPath: string = SENTRY_NEXTJS_CONFIG_IMPORT_PATH,
): void {
  mod.imports.$add({
    from: importPath,
    imported: "withSentryConfig",
    local: "withSentryConfig",
  });
}

export function getNextJsVersionBucket(version: string | undefined) {
  if (!version) {
    return "none";
  }

  try {
    const minVer = minVersion(version);
    if (!minVer) {
      return "invalid";
    }
    const majorVersion = major(minVer);
    if (majorVersion >= 11) {
      return `${majorVersion}.x`;
    }
    return "<11.0.0";
  } catch (error) {
    debug(error);
    return "unknown";
  }
}

export function getMaybeAppDirLocation() {
  const maybeAppDirPath = path.join(process.cwd(), "app");
  const maybeSrcAppDirPath = path.join(process.cwd(), "src", "app");

  return existsSync(maybeAppDirPath) && lstatSync(maybeAppDirPath).isDirectory()
    ? ["app"]
    : existsSync(maybeSrcAppDirPath) &&
        lstatSync(maybeSrcAppDirPath).isDirectory()
      ? ["src", "app"]
      : undefined;
}

export function hasRootLayoutFile(appFolderPath: string) {
  return ["jsx", "tsx", "js"].some((ext) =>
    existsSync(path.join(appFolderPath, `layout.${ext}`)),
  );
}

/**
 * Unwraps a withSentryConfig call expression using magicast.
 */
export function unwrapSentryConfigAst(astNode: ASTNode): ASTNode {
  if (
    astNode.type === "CallExpression" &&
    astNode.callee.type === "Identifier" &&
    astNode.callee.name === "withSentryConfig"
  ) {
    // Return the first argument (the config being wrapped)
    return astNode.arguments[0] ?? astNode;
  }

  return astNode;
}

/**
 * Wraps a magicast module export with withSentryConfig using magicast
 */
export function wrapWithSentryConfig(
  moduleExport: unknown,
  optionsTemplate: string,
): ReturnType<typeof builders.functionCall> {
  return builders.functionCall(
    "withSentryConfig",
    moduleExport,
    builders.raw(optionsTemplate),
  );
}
