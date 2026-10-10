/**
 * sentry dart-symbol-map
 *
 * Route map for Dart/Flutter symbol map commands.
 */

import { buildRouteMap } from "../../lib/route-map.js";
import { uploadCommand } from "./upload.js";

export const dartSymbolMapRoute = buildRouteMap({
  routes: {
    upload: uploadCommand,
  },
  docs: {
    brief: "Work with Dart/Flutter symbol maps",
    fullDescription:
      "Upload Dart/Flutter obfuscation maps for deobfuscating Dart " +
      "exception types in Sentry.",
  },
});
