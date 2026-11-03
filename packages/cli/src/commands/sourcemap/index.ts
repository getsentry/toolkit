import { buildRouteMap } from "../../lib/route-map.js";
import { topLevelBrief } from "../../top-level-briefs.js";
import { injectCommand } from "./inject.js";
import { resolveCommand } from "./resolve.js";
import { uploadCommand } from "./upload.js";

export const sourcemapRoute = buildRouteMap({
  routes: {
    inject: injectCommand,
    upload: uploadCommand,
    resolve: resolveCommand,
  },
  docs: {
    brief: topLevelBrief("sourcemap"),
    fullDescription:
      "Inject debug IDs and upload sourcemaps to Sentry.\n\n" +
      "Alias: `sentry sourcemaps` → `sentry sourcemap`",
    hideRoute: {},
  },
});
