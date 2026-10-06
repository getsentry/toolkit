/**
 * Debug ID injection for JavaScript sourcemaps.
 *
 * Injects Sentry debug IDs into JavaScript files and their companion
 * sourcemaps for reliable server-side stack trace resolution. Debug IDs
 * replace fragile filename/release-based sourcemap matching with a
 * deterministic UUID embedded in both the JS file and its sourcemap.
 *
 * The UUID algorithm and runtime snippet are byte-for-byte compatible
 * with `@sentry/bundler-plugin-core`'s `stringToUUID` and
 * `getDebugIdSnippet` — see ECMA-426 (Source Map Format) for the spec.
 *
 * The debug ID is derived from the minified JS content combined with its
 * sourcemap content, so distinct minified artifacts never collide onto a
 * single ID even when their sourcemaps are byte-identical
 * (getsentry/sentry-cli#3350). The `stringToUUID` compatibility concerns the
 * hash-to-UUID function itself, not its input; the CLI's `inject` and the
 * bundler plugin run in mutually exclusive workflows, so their debug IDs need
 * not match.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { UUID_DASH_RE } from "../hex-id.js";
import { logger } from "../logger.js";
import { isLikelyBinary } from "../scan/binary.js";
import {
  type DecodedInlineMap,
  encodeInlineSourcemap,
} from "./inline-sourcemap.js";

const log = logger.withTag("sourcemap.debug-id");

/** Comment prefix used to identify an existing debug ID in a JS file. */
const DEBUGID_COMMENT_PREFIX = "//# debugId=";

/** Regex to extract an existing debug ID from a JS file. @internal */
export const EXISTING_DEBUGID_RE = /\/\/# debugId=([0-9a-fA-F-]{36})/;

/** Indexed registry writes emitted by Sentry's bundler plugins and legacy CLI. */
const DEBUGID_REGISTRATION_RE =
  /(?:\.\s*_sentryDebugIds|\[\s*["']_sentryDebugIds["']\s*\])\s*\[\s*[$\w]+\s*\]\s*=\s*(["'])([0-9a-fA-F-]{36})\1/g;

/**
 * Recognize a Sentry runtime snippet registering the selected debug ID.
 * SDK registry reads and ECMA-426 comments alone do not register a bundle.
 * Match the writer rather than the identifier marker, which the legacy CLI
 * does not emit. This recognizes emitted snippets, not arbitrary JavaScript.
 * @internal
 */
export function hasDebugIdRegistration(js: string, debugId: string): boolean {
  for (const match of js.matchAll(DEBUGID_REGISTRATION_RE)) {
    if (match[2]?.toLowerCase() === debugId.toLowerCase()) {
      return true;
    }
  }
  return false;
}

/**
 * Read a pre-existing debug ID off a parsed sourcemap.
 *
 * `debug_id` wins over `debugId` when both are present. A value that is not a
 * well-formed UUID is treated as absent so the caller falls through to minting.
 *
 * @param map - A parsed sourcemap object (any shape; fields are probed)
 * @returns The debug ID, or `undefined` when the map carries none
 * @internal
 */
export function readSourcemapDebugId(map: unknown): string | undefined {
  if (typeof map !== "object" || map === null) {
    return;
  }
  const { debug_id: snake, debugId: camel } = map as SourcemapJson;
  for (const candidate of [snake, camel]) {
    if (typeof candidate === "string" && UUID_DASH_RE.test(candidate)) {
      return candidate;
    }
  }
  return;
}

/**
 * Generate a deterministic debug ID (UUID v4 format) from content.
 *
 * Computes SHA-256 of the input, then formats the first 128 bits as a
 * UUID v4 string. Matches `@sentry/bundler-plugin-core`'s `stringToUUID`
 * exactly — position 12 is forced to `4` (version), and position 16 is
 * forced to one of `8/9/a/b` (variant, RFC 4122 §4.4).
 *
 * @param content - File content (string or Buffer) to hash
 * @returns UUID v4 string, e.g. `"a1b2c3d4-e5f6-4789-abcd-ef0123456789"`
 */
export function contentToDebugId(content: string | Buffer): string {
  const hash = createHash("sha256").update(content).digest("hex");
  // Position 16 (first char of 5th group in the hash) determines the
  // variant nibble. charCodeAt(0) of a hex digit is deterministic.
  const v4variant = ["8", "9", "a", "b"][
    hash.substring(16, 17).charCodeAt(0) % 4
  ];
  return `${hash.substring(0, 8)}-${hash.substring(8, 12)}-4${hash.substring(13, 16)}-${v4variant}${hash.substring(17, 20)}-${hash.substring(20, 32)}`.toLowerCase();
}

/**
 * Build the runtime IIFE snippet that registers a debug ID in
 * `globalThis._sentryDebugIds`.
 *
 * At runtime, the Sentry SDK reads this map (keyed by Error stack traces)
 * to associate stack frames with their debug IDs, which are then used to
 * look up the correct sourcemap on the server.
 *
 * The snippet is a single-line IIFE so it only adds one line to the
 * sourcemap mappings offset.
 *
 * @param debugId - The UUID to embed
 * @returns Minified IIFE string (single line, starts with `;`)
 */
export function getDebugIdSnippet(debugId: string): string {
  return `;!function(){try{var e="undefined"!=typeof window?window:"undefined"!=typeof global?global:"undefined"!=typeof globalThis?globalThis:"undefined"!=typeof self?self:{},n=(new e.Error).stack;n&&(e._sentryDebugIds=e._sentryDebugIds||{},e._sentryDebugIds[n]="${debugId}",e._sentryDebugIdIdentifier="sentry-dbid-${debugId}")}catch(e){}}();`;
}

/**
 * Prepend the runtime IIFE snippet to a JS file's content, preserving a
 * leading hashbang (`#!`) line if present.
 *
 * The snippet must run before any other code but after the hashbang, which
 * must remain the first line for the file to stay executable.
 *
 * @param jsContent - Original JS file content
 * @param snippet - The IIFE snippet from {@link getDebugIdSnippet}
 * @returns The JS content with the snippet prepended
 * @internal
 */
export function prependDebugIdSnippet(
  jsContent: string,
  snippet: string
): string {
  if (jsContent.startsWith("#!")) {
    const newlineIdx = jsContent.indexOf("\n");
    // Handle hashbang without trailing newline (entire file is the #! line)
    const splitAt = newlineIdx === -1 ? jsContent.length : newlineIdx + 1;
    const hashbang = jsContent.slice(0, splitAt);
    const rest = jsContent.slice(splitAt);
    const sep = newlineIdx === -1 ? "\n" : "";
    return `${hashbang}${sep}${snippet}\n${rest}`;
  }
  return `${snippet}\n${jsContent}`;
}

/**
 * Inject a Sentry debug ID into a JavaScript file and its companion
 * sourcemap.
 *
 * By default performs four mutations:
 * 1. Prepends the runtime snippet to the JS file (after any hashbang)
 * 2. Appends a `//# debugId=<uuid>` comment to the JS file
 * 3. Prepends a `;` to the sourcemap `mappings` (offsets by one line)
 * 4. Adds `debug_id` and `debugId` fields to the sourcemap JSON
 *
 * When `options.skipSnippet` is `true`, step 1 is skipped and step 3
 * is adjusted (no extra `;` prefix since no snippet line is added).
 * This is used by the CLI's own build pipeline where the debug ID is
 * registered in source code (`constants.ts`) instead of via the IIFE.
 *
 * Existing IDs are preserved (JS comment first, then sourcemap). Files with
 * a runtime registration for that ID are left untouched to preserve SRI.
 * Otherwise the missing snippet is injected under the existing ID. In
 * metadata-only mode, an existing ID is sufficient to leave files untouched.
 * Binary bundles with an existing ID are also preserved: adding JavaScript
 * would corrupt bytecode such as Hermes bundles.
 *
 * @param jsPath - Path to the JavaScript file
 * @param mapPath - Path to the companion `.map` file
 * @param options - Optional settings
 * @param options.skipSnippet - Skip the IIFE runtime snippet (steps 1 & 3)
 * @returns The debug ID and whether it was newly injected
 */
export async function injectDebugId(
  jsPath: string,
  mapPath: string,
  options?: { skipSnippet?: boolean }
): Promise<{ debugId: string; wasInjected: boolean }> {
  const [jsBytes, mapContent] = await Promise.all([
    readFile(jsPath),
    readFile(mapPath, "utf-8"),
  ]);
  const jsContent = jsBytes.toString("utf-8");

  const skipSnippet = options?.skipSnippet ?? false;
  const skipRuntimeCheck = skipSnippet || isLikelyBinary(jsBytes);
  const jsDebugId = jsContent.match(EXISTING_DEBUGID_RE)?.[1];
  if (
    jsDebugId &&
    (skipRuntimeCheck || hasDebugIdRegistration(jsContent, jsDebugId))
  ) {
    return { debugId: jsDebugId, wasInjected: false };
  }

  const map = JSON.parse(mapContent) as SourcemapJson;
  const existingId = jsDebugId ?? readSourcemapDebugId(map);
  if (
    existingId &&
    (skipRuntimeCheck || hasDebugIdRegistration(jsContent, existingId))
  ) {
    return { debugId: existingId, wasInjected: false };
  }

  // Derive the debug ID from the minified JS content combined with the
  // sourcemap content. Hashing both guarantees that distinct minified
  // artifacts receive distinct debug IDs even when their sourcemaps are
  // byte-identical — e.g. esbuild's empty
  // `{"version":3,"sources":[],"names":[],"mappings":""}` maps for
  // helper/re-export-only chunks (getsentry/sentry-cli#3350). A `\0`
  // separator can't occur in JS/JSON text, so the two inputs can't bleed
  // across the boundary. Collisions now require both files to be
  // byte-identical, in which case sharing an ID is correct.
  const debugId = existingId ?? contentToDebugId(`${jsContent}\0${mapContent}`);

  // --- Mutate JS file ---
  let newJs: string;
  if (skipSnippet) {
    // Metadata-only mode: just append the debugId comment, no IIFE snippet.
    // Used by the CLI's own build where the debug ID is registered in source.
    newJs = jsContent;
  } else {
    // Full mode: prepend the runtime IIFE snippet (for user-facing injection).
    newJs = prependDebugIdSnippet(jsContent, getDebugIdSnippet(debugId));
  }
  if (!jsDebugId) {
    newJs += `\n${DEBUGID_COMMENT_PREFIX}${debugId}\n`;
  }

  // --- Mutate sourcemap ---
  mutateSourcemap(map, debugId, { offsetMappings: !skipSnippet });

  // Write both files concurrently
  await Promise.all([
    writeFile(jsPath, newJs),
    writeFile(mapPath, JSON.stringify(map)),
  ]);

  return { debugId, wasInjected: true };
}

/** Minimal shape of a sourcemap JSON object that we mutate during injection. */
type SourcemapJson = {
  mappings?: string;
  sources?: (string | null)[];
  debug_id?: string;
  debugId?: string;
};

/**
 * Mutate a parsed sourcemap in place to carry a debug ID.
 *
 * - Normalizes Windows backslashes in `sources` to forward slashes so
 *   uploaded paths are platform-consistent (esbuild/Bun on Windows emit
 *   `"src\\bin.ts"`). No-op on Linux/macOS.
 * - When `offsetMappings` is true, prepends one `;` to `mappings` to account
 *   for the injected IIFE snippet line (each `;` is a VLQ line boundary).
 * - Sets both `debug_id` and `debugId` fields.
 *
 * @param map - The parsed sourcemap object (mutated in place)
 * @param debugId - The debug ID to embed
 * @param options.offsetMappings - Prepend a `;` to `mappings` (snippet added a line)
 */
function mutateSourcemap(
  map: SourcemapJson,
  debugId: string,
  options: { offsetMappings: boolean }
): void {
  if (map.sources) {
    map.sources = map.sources.map((s) => (s ? s.replaceAll("\\", "/") : s));
  }
  if (options.offsetMappings && typeof map.mappings === "string") {
    map.mappings = `;${map.mappings}`;
  }
  map.debug_id = debugId;
  map.debugId = debugId;
}

/**
 * Regex matching a `//# sourceMappingURL=data:...;base64,...` directive at the
 * **start of a line** (optionally indented).
 *
 * Anchored with `^` under the multiline flag so it only matches a directive
 * that *begins* a line — mirroring discovery's line-based parser
 * (`parseSourceMappingDirective`). This prevents rewriting a false-positive
 * `data:` URL embedded mid-line inside a string/template literal while leaving
 * the authoritative trailing directive untouched. Global so all matches can be
 * iterated and only the **last** one rewritten (spec: last directive wins).
 *
 * @internal
 */
const INLINE_DIRECTIVE_RE =
  /^[ \t]*\/\/[#@][ \t]*sourceMappingURL[ \t]*=[ \t]*data:application\/json(?:;charset=[\w-]+)?;base64,[A-Za-z0-9+/=]+/gm;

/**
 * Inject a debug ID into a JS file whose sourcemap is inline (a base64
 * `data:` URL) rather than a companion `.map` file.
 *
 * The decoded map is provided by the caller (see `tryDecodeInlineSourcemap`).
 * This performs the same JS mutations as {@link injectDebugId} (IIFE snippet +
 * `//# debugId=` comment) and additionally re-encodes the debug-ID-injected
 * map back into the `sourceMappingURL=data:...;base64,<NEW>` directive **in
 * place**, so the file stays self-contained. Only the **last** inline
 * directive is rewritten.
 *
 * Existing IDs from the JS comment or decoded map are reused. Files already
 * registering that ID at runtime are left unchanged.
 *
 * @param jsPath - Path to the JavaScript file
 * @param decoded - The decoded inline sourcemap and its re-encode metadata
 * @returns The debug ID, whether it was newly injected, and the injected map
 *   content (for upload as a standalone artifact). When the directive cannot
 *   be located for rewrite, returns an empty `debugId` and no
 *   `injectedMapContent` so callers attach nothing inconsistent.
 */
export async function injectInlineDebugId(
  jsPath: string,
  decoded: DecodedInlineMap
): Promise<{
  debugId: string;
  wasInjected: boolean;
  injectedMapContent?: Buffer;
}> {
  // Full read required: the directive lives in the file body and must be
  // rewritten in place.
  const jsBytes = await readFile(jsPath);
  const jsContent = jsBytes.toString("utf-8");

  const jsDebugId = jsContent.match(EXISTING_DEBUGID_RE)?.[1];
  const existingId = jsDebugId ?? readSourcemapDebugId(decoded.map);
  if (
    existingId &&
    (isLikelyBinary(jsBytes) || hasDebugIdRegistration(jsContent, existingId))
  ) {
    return {
      debugId: existingId,
      wasInjected: false,
      injectedMapContent: Buffer.from(decoded.json),
    };
  }

  // Derive from the minified JS content combined with the (decoded) inline
  // sourcemap, mirroring the external path so distinct chunks that share a
  // byte-identical inline map still get distinct debug IDs
  // (getsentry/sentry-cli#3350). `jsContent` already embeds the inline map,
  // so this is belt-and-suspenders, but keeps the two paths symmetric.
  const debugId =
    existingId ?? contentToDebugId(`${jsContent}\0${decoded.json}`);

  // Locate the LAST inline directive to rewrite. If it can't be found (the
  // discovery parser and this regex disagree on an edge case), abort WITHOUT
  // modifying the file. Return an EMPTY debug ID and no map content so the
  // upload path attaches nothing — otherwise a debug ID and pre-injection map
  // would be uploaded for a bundle that has no snippet/comment/updated map.
  const matches = [...jsContent.matchAll(INLINE_DIRECTIVE_RE)];
  const last = matches.at(-1);
  if (last?.index === undefined) {
    log.debug(
      `inline sourcemap directive not found for rewrite in ${jsPath}; leaving file unmodified`
    );
    return { debugId: "", wasInjected: false };
  }

  // Mutate the decoded map (IIFE adds one top line — same offset as external).
  const map = decoded.map as SourcemapJson;
  mutateSourcemap(map, debugId, { offsetMappings: true });
  const newDataUrl = encodeInlineSourcemap(map, decoded.dataUrlPrefix);

  // Rewrite the directive in place, before prepending the snippet / appending
  // the comment so the regex operated on the original body. We splice the last
  // match by index (String.replace would hit the first).
  const start = last.index;
  const end = start + last[0].length;
  const prefixEnd = last[0].indexOf("data:");
  const directivePrefix = last[0].slice(0, prefixEnd);
  const rewritten =
    jsContent.slice(0, start) +
    directivePrefix +
    newDataUrl +
    jsContent.slice(end);

  let newJs = prependDebugIdSnippet(rewritten, getDebugIdSnippet(debugId));
  if (!jsDebugId) {
    newJs += `\n${DEBUGID_COMMENT_PREFIX}${debugId}\n`;
  }

  await writeFile(jsPath, newJs);

  return {
    debugId,
    wasInjected: true,
    injectedMapContent: Buffer.from(JSON.stringify(map)),
  };
}
