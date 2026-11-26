/**
 * Detect the build tool of a project from its `package.json`, to preselect
 * it in the source maps wizard.
 */

import { getPackageDotJson } from "../../utils/clack/index.js";
import { findInstalledPackageFromList } from "../../utils/package-json.js";

/**
 * The tools the source maps wizard can configure. `sentry-cli` is the
 * generic flow that uploads with the `sentry` CLI (kept as the id so the
 * `selected-tool` telemetry tag stays comparable).
 */
export type SupportedTools =
  | "webpack"
  | "vite"
  | "rollup"
  | "esbuild"
  | "tsc"
  | "sentry-cli"
  | "create-react-app"
  | "angular"
  | "wrangler"
  | "no-tool";

/**
 * Package names pointing to the tool they indicate. The order matters: the
 * most specific tool comes first. For instance, webpack comes before tsc
 * because webpack projects often depend on `typescript` too.
 */
const TOOL_PACKAGE_MAP: Record<string, SupportedTools> = {
  "@angular/core": "angular",
  "create-react-app": "create-react-app",
  wrangler: "wrangler",
  webpack: "webpack",
  vite: "vite",
  esbuild: "esbuild",
  rollup: "rollup",
  typescript: "tsc",
};

/**
 * The tool of the first package in {@link TOOL_PACKAGE_MAP} the project
 * depends on, or the generic `sentry-cli` flow.
 */
export async function detectUsedTool(): Promise<SupportedTools> {
  const packageJson = await getPackageDotJson();

  const foundToolPackage = findInstalledPackageFromList(
    Object.keys(TOOL_PACKAGE_MAP),
    packageJson,
  );

  return (
    (foundToolPackage && TOOL_PACKAGE_MAP[foundToolPackage.name]) ||
    "sentry-cli"
  );
}
