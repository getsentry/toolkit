import { buildRouteMap } from "../../lib/route-map.js";
import { snakeCommand } from "./snake.js";

export const gamesRoute = buildRouteMap({
  routes: {
    snake: snakeCommand,
  },
  docs: {
    brief: "Terminal games",
    fullDescription: "Small games to play in your terminal while you wait.",
  },
});
