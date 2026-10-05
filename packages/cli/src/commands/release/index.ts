/**
 * sentry release
 *
 * Route map for release management commands.
 */

import { buildRouteMap } from "../../lib/route-map.js";
import { archiveCommand } from "./archive.js";
import { createCommand } from "./create.js";
import { deleteCommand } from "./delete.js";
import { deployCommand } from "./deploy.js";
import { deploysCommand } from "./deploys.js";
import { finalizeCommand } from "./finalize.js";
import { listCommand } from "./list.js";
import { proposeVersionCommand } from "./propose-version.js";
import { restoreCommand } from "./restore.js";
import { setCommitsCommand } from "./set-commits.js";
import { viewCommand } from "./view.js";

export const releaseRoute = buildRouteMap({
  routes: {
    list: listCommand,
    view: viewCommand,
    create: createCommand,
    finalize: finalizeCommand,
    delete: deleteCommand,
    archive: archiveCommand,
    restore: restoreCommand,
    deploy: deployCommand,
    deploys: deploysCommand,
    "set-commits": setCommitsCommand,
    "propose-version": proposeVersionCommand,
  },
  docs: {
    brief: "Work with Sentry releases",
    fullDescription:
      "List, create, finalize, and deploy Sentry releases.\n\n" +
      "Alias: `sentry releases` → `sentry release list`",
    hideRoute: {},
  },
});
