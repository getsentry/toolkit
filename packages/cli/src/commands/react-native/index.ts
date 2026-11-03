/**
 * sentry react-native
 *
 * Route map for React Native build-tool integration commands.
 */

import { buildRouteMap } from "../../lib/route-map.js";
import { topLevelBrief } from "../../top-level-briefs.js";
import { gradleCommand } from "./gradle.js";
import { xcodeCommand } from "./xcode.js";

export const reactNativeRoute = buildRouteMap({
  routes: {
    gradle: gradleCommand,
    xcode: xcodeCommand,
  },
  docs: {
    brief: topLevelBrief("react-native"),
    fullDescription:
      "Integrations for uploading React Native bundles and sourcemaps from " +
      "native build steps (Gradle/Xcode).",
  },
});
