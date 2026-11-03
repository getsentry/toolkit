/**
 * sentry dart-symbol-map
 *
 * Route map for Dart/Flutter symbol map commands.
 */

import { topLevelBrief } from "../../command-manifest.js";
import { buildRouteMap } from "../../lib/route-map.js";
import { uploadCommand } from "./upload.js";

export const dartSymbolMapRoute = buildRouteMap({
  routes: {
    upload: uploadCommand,
  },
  docs: {
    brief: topLevelBrief("dart-symbol-map"),
    fullDescription:
      "Upload Dart/Flutter obfuscation maps for deobfuscating Dart " +
      "exception types in Sentry.",
  },
});
