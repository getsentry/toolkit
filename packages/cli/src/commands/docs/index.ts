import { buildRouteMap } from "../../lib/route-map.js";
import { listCommand } from "./list.js";
import { queryCommand } from "./query.js";

export const docsRoute = buildRouteMap({
  routes: { list: listCommand, query: queryCommand },
  aliases: { search: "query" },
  defaultCommand: "query",
  docs: {
    brief: "Search and query current Sentry documentation",
    fullDescription:
      "Ask cited documentation questions or search the docs index.\n\n" +
      "Commands:\n  query  Ask a natural-language question (default; alias: search)\n  list   Find matching documentation pages by keyword",
    hideRoute: {},
  },
});
