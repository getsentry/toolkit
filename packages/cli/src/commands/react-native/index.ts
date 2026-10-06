/**
 * sentry react-native
 *
 * Route map for React Native build-tool integration commands.
 */

import { buildRouteMap } from "../../lib/route-map.js";
import { gradleCommand } from "./gradle.js";
import { xcodeCommand } from "./xcode.js";

export const reactNativeRoute = buildRouteMap({
  routes: {
    gradle: gradleCommand,
    xcode: xcodeCommand,
  },
  docs: {
    brief: "Upload React Native sourcemaps from build steps",
    fullDescription:
      "Integrations for uploading React Native bundles and sourcemaps from " +
      "native build steps (Gradle/Xcode).",
  },
});
