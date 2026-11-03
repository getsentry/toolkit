import { buildRouteMap } from "../../lib/route-map.js";
import { topLevelBrief } from "../../top-level-briefs.js";
import { listCommand } from "./list.js";
import { queryCommand } from "./query.js";

export const docsRoute = buildRouteMap({
  routes: { list: listCommand, query: queryCommand },
  aliases: { search: "query" },
  defaultCommand: "query",
  docs: {
    brief: topLevelBrief("docs"),
    fullDescription:
      "Ask cited documentation questions or search the docs index.\n\n" +
      "Commands:\n  query  Ask a natural-language question (default; alias: search)\n  list   Find matching documentation pages by keyword",
    hideRoute: {},
  },
});
