/**
 * sentry debug-files
 *
 * Route map for debug file commands.
 */

import { buildRouteMap } from "../../lib/route-map.js";
import { bundleJvmCommand } from "./bundle-jvm.js";
import { bundleSourcesCommand } from "./bundle-sources.js";
import { checkCommand } from "./check.js";
import { findCommand } from "./find.js";
import { printSourcesCommand } from "./print-sources.js";
import { uploadCommand } from "./upload.js";

export const debugFilesRoute = buildRouteMap({
  routes: {
    check: checkCommand,
    find: findCommand,
    upload: uploadCommand,
    "print-sources": printSourcesCommand,
    "bundle-sources": bundleSourcesCommand,
    "bundle-jvm": bundleJvmCommand,
  },
  docs: {
    brief: "Work with debug information files",
    fullDescription:
      "Create and manage debug information files (DIFs) for source context " +
      "in Sentry stack traces.",
  },
});
