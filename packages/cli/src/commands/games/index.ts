import { buildRouteMap } from "../../lib/route-map.js";
import { leaderboardCommand } from "./leaderboard.js";
import { snakeCommand } from "./snake.js";

export const gamesRoute = buildRouteMap({
  routes: {
    leaderboard: leaderboardCommand,
    snake: snakeCommand,
  },
  docs: {
    brief: "Terminal games",
    fullDescription: "Small games to play in your terminal while you wait.",
  },
});
