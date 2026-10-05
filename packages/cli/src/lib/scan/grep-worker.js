/**
 * Grep worker body. Imported as raw text (`with { type: "text" }`)
 * by `worker-pool.ts` and spawned via `Blob` + `URL.createObjectURL`.
 *
 * Kept as plain `.js` (no TS) so it's valid Worker input verbatim
 * with no transpile step. Self-contained: no imports from local
 * modules (the worker's module registry wouldn't have them).
 *
 * ## Protocol
 *
 * Main → Worker: `{ paths, patternSource, flags, maxLineLength,
 *   maxMatchesPerFile, literal }`.
 *
 * Worker → Main:
 * - `{ type: "ready" }` once on startup.
 * - `{ type: "result", ints: Uint32Array, linePoolBytes: Uint8Array }`
 *   per request. Both buffers are transferred (zero-copy).
 *
 * ## Match encoding
 *
 * Each match is 4 consecutive `u32`s in `ints`:
 *   [0] pathIdx     index into the input `paths` array
 *   [1] lineNum     1-based line number
 *   [2] lineOffset  character offset into the decoded line pool
 *   [3] lineLength  character length of the line (post-truncation)
 *
 * The line pool is built as a JS string on the worker, UTF-8 encoded
 * just before `postMessage`, and decoded back on the main side.
 * Offsets stay in UTF-16 code-unit space; the encode/decode round
 * trip preserves `.length` for all valid code points. Shipping the
 * pool as a transferable `Uint8Array` keeps both buffers on
 * `postMessage`'s zero-copy path — mixing a string with a
 * transferable falls back to the slow structured-clone path in Bun.
 */

const { readFileSync } = require("node:fs");

const textEncoder = new TextEncoder();

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: hot regex loop with literal gate + line counter + line-bound extraction + per-file cap is inherently branchy
self.onmessage = (event) => {
  const {
    paths,
    patternSource,
    flags,
    maxLineLength,
    maxMatchesPerFile,
    literal,
  } = event.data;
  const regex = new RegExp(patternSource, flags);
  const ints = [];
  let linePool = "";

  for (let pathIdx = 0; pathIdx < paths.length; pathIdx += 1) {
    const p = paths[pathIdx];
    let content;
    try {
      content = readFileSync(p, "utf-8");
    } catch {
      continue;
    }

    if (literal !== null) {
      const haystack = regex.flags.includes("i")
        ? content.toLowerCase()
        : content;
      if (haystack.indexOf(literal) === -1) {
        continue;
      }
    }

    regex.lastIndex = 0;
    let m = regex.exec(content);
    let lineNum = 1;
    let cursor = 0;
    let fileMatches = 0;

    while (m !== null) {
      const matchIndex = m.index;
      // Advance line counter to the match position via indexOf hops.
      let nl = content.indexOf("\n", cursor);
      while (nl !== -1 && nl < matchIndex) {
        lineNum += 1;
        nl = content.indexOf("\n", nl + 1);
      }
      cursor = matchIndex;

      const lineStart = content.lastIndexOf("\n", matchIndex) + 1;
      const lineEndRaw = content.indexOf("\n", matchIndex);
      const lineEnd = lineEndRaw === -1 ? content.length : lineEndRaw;
      let line = content.slice(lineStart, lineEnd);
      if (line.length > maxLineLength) {
        // Back off if the cut lands on a high surrogate — splitting
        // a pair leaves a lone half that `TextEncoder.encode`
        // replaces with U+FFFD on the wire.
        let cut = maxLineLength - 1;
        const lastCode = line.charCodeAt(cut - 1);
        if (lastCode >= 0xd8_00 && lastCode <= 0xdb_ff) {
          cut -= 1;
        }
        line = `${line.slice(0, cut)}\u2026`;
      }

      const lineOffset = linePool.length;
      linePool += line;
      ints.push(pathIdx, lineNum, lineOffset, line.length);

      fileMatches += 1;
      if (fileMatches >= maxMatchesPerFile) {
        break;
      }
      if (lineEndRaw === -1) {
        break;
      }
      regex.lastIndex = lineEnd + 1;
      m = regex.exec(content);
    }
  }

  const packed = new Uint32Array(ints);
  const linePoolBytes = textEncoder.encode(linePool);
  self.postMessage(
    { type: "result", ints: packed, linePoolBytes },
    { transfer: [packed.buffer, linePoolBytes.buffer] }
  );
};

self.postMessage({ type: "ready" });
