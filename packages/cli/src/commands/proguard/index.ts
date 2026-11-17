/**
 * sentry proguard
 *
 * Route map for ProGuard/R8 mapping commands.
 */

import { buildRouteMap } from "../../lib/route-map.js";
import { topLevelBrief } from "../../top-level-briefs.js";
import { uploadCommand } from "./upload.js";
import { uuidCommand } from "./uuid.js";

export const proguardRoute = buildRouteMap({
  routes: {
    upload: uploadCommand,
    uuid: uuidCommand,
  },
  docs: {
    brief: topLevelBrief("proguard"),
    fullDescription:
      "Upload and manage Android ProGuard/R8 mapping files.\n\n" +
      "The UUID is derived deterministically from the mapping file contents " +
      "and identifies the mapping when deobfuscating Android stack traces.",
  },
});
