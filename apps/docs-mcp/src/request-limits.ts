/**
 * Input budgets for the docs Worker (GHSA-46jr-4wx8-v453).
 *
 * The largest bounded request is `query-docs`: a 2,000-character query plus at
 * most 40 context strings of 100 characters. Even with every character escaped
 * as `\uXXXX`, that stays under 40 KiB. The other inputs are short slugs,
 * keywords, and a stack summary, so 64 KiB covers every supported request while
 * keeping what one request can make the Worker parse small.
 */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;

/**
 * Largest combined number of array elements and object keys in one MCP
 * `tools/call` `arguments` payload. `query-docs` peaks at about 45 (40 context
 * strings plus their keys); `libs` and `features` lists hold tens of slugs.
 * 1,000 leaves wide headroom for real codebases.
 */
export const MAX_TOOL_INPUT_ELEMENTS = 1_000;
