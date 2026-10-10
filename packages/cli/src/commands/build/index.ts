/**
 * `sentry build` — manage mobile build artifacts for preprod size analysis.
 *
 * Exposes `upload` (Android APK/AAB) and `download`. iOS XCArchive/IPA upload
 * is ported separately.
 */

import { buildRouteMap } from "../../lib/route-map.js";
import { downloadCommand } from "./download.js";
import { uploadCommand } from "./upload.js";

export const buildRoute = buildRouteMap({
  routes: {
    upload: uploadCommand,
    download: downloadCommand,
  },
  docs: {
    brief: "Manage mobile build artifacts",
    fullDescription:
      "Upload and download mobile build artifacts (APK/AAB/IPA/XCArchive) for " +
      "Sentry preprod size analysis. Sentry SaaS only.",
  },
});
