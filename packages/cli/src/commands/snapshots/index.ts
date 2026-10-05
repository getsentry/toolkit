/**
 * `sentry snapshots` — manage and compare preprod snapshot images.
 *
 * Exposes `upload`, `download`, and `diff`.
 */

import { buildRouteMap } from "../../lib/route-map.js";
import { diffCommand } from "./diff.js";
import { downloadCommand } from "./download.js";
import { uploadCommand } from "./upload.js";

export const snapshotsRoute = buildRouteMap({
  routes: {
    diff: diffCommand,
    download: downloadCommand,
    upload: uploadCommand,
  },
  docs: {
    brief: "Manage and compare snapshots",
  },
});
