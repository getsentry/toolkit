/**
 * sentry code-mappings
 *
 * Route map for code mapping commands.
 */

import { buildRouteMap } from "../../lib/route-map.js";
import { uploadCommand } from "./upload.js";

export const codeMappingsRoute = buildRouteMap({
  routes: {
    upload: uploadCommand,
  },
  docs: {
    brief: "Manage code mappings for stack trace linking",
    fullDescription:
      "Upload and manage code mappings that link stack trace paths to " +
      "source code paths in your repository.",
  },
});
