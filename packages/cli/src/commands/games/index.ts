/**
 * sentry games
 *
 * Small games to play in the terminal.
 */

import { buildRouteMap } from "../../lib/route-map.js";
import { topLevelBrief } from "../../top-level-briefs.js";
import { snakeCommand } from "./snake.js";

export const gamesRoute = buildRouteMap({
  routes: {
    snake: snakeCommand,
  },
  docs: {
    brief: topLevelBrief("games"),
    fullDescription: "Small games to play in your terminal while you wait.",
  },
});
