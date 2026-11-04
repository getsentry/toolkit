/**
 * The kitty/sixel image banner that help shows on capable terminals.
 *
 * Entry points that render the branded help register it, rather than
 * `lib/help.ts` importing it, so applications without it (`@sentry/mcp-server`)
 * leave the image code out of their bundle.
 */

import { setGraphicsBanner } from "./lib/help.js";
import { graphicsBanner, graphicsBannerExtraRows } from "./lib/sixel.js";

/** Register the image banner with the branded help. */
export function registerGraphicsBanner(): void {
  setGraphicsBanner({
    render: graphicsBanner,
    extraRows: graphicsBannerExtraRows,
  });
}
