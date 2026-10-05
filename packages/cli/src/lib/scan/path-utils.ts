/**
 * Internal path + pattern utilities shared by the grep and glob
 * engines. Not part of the public barrel — implementation details
 * factored out to prevent drift between the two engines.
 */

import path from "node:path";
import picomatch from "picomatch";

/**
 * A precompiled glob matcher. We cache whether the pattern is
 * "path-mode" (tested against the relative path, e.g. `src/*.ts`)
 * vs "basename-mode" (tested against just the file's basename, e.g.
 * `*.ts`) so the per-file call skips the `pattern.includes("/")` check
 * every time.
 *
 * Matches the init-wizard's fs-fallback heuristic and ripgrep's
 * `--glob` semantics: patterns with `/` anchor to the relative path
 * from cwd, patterns without `/` match the basename anywhere.
 */
export type CompiledMatcher = {
  test: (input: string) => boolean;
  pathMode: boolean;
};

/**
 * Compile a picomatch matcher for a single glob pattern. `dot: true`
 * so dotfiles aren't silently excluded (the walker's own `hidden`
 * flag owns that policy; glob patterns should match whatever the
 * walker yields).
 */
export function compileMatcher(pattern: string): CompiledMatcher {
  return {
    test: picomatch(pattern, { dot: true }),
    pathMode: pattern.includes("/"),
  };
}

/**
 * Compile zero or more glob patterns. The input is the shape grep
 * and glob both accept on their options objects: `string | readonly
 * string[] | undefined`. Undefined returns an empty array so callers
 * can short-circuit on `.length === 0` without null-checks.
 */
export function compileMatchers(
  patterns: string | readonly string[] | undefined
): CompiledMatcher[] {
  if (patterns === undefined) {
    return [];
  }
  const list = typeof patterns === "string" ? [patterns] : patterns;
  return list.map(compileMatcher);
}

/**
 * True if at least one matcher accepts the given path. The caller
 * supplies both the relative path and its basename so we don't
 * recompute the basename per matcher.
 *
 * Path-mode matchers test against `relPath`, basename-mode against
 * `basename` — see `CompiledMatcher.pathMode`.
 */
export function matchesAny(
  matchers: readonly CompiledMatcher[],
  relPath: string,
  basename: string
): boolean {
  for (const m of matchers) {
    if (m.test(m.pathMode ? relPath : basename)) {
      return true;
    }
  }
  return false;
}

/**
 * Extract the basename (segment after the last `/`) from a
 * POSIX-normalized relative path. Equivalent to `path.posix.basename`
 * but avoids the import cycle + is slightly cheaper on the hot path.
 */
export function basenameOf(rel: string): string {
  const slashIdx = rel.lastIndexOf("/");
  return slashIdx === -1 ? rel : rel.slice(slashIdx + 1);
}

/**
 * Join two POSIX-style path segments with a single `/` separator,
 * trimming a trailing `/` on the left or a leading `/` on the right
 * so we never produce a `//` in the middle.
 */
export function joinPosix(a: string, b: string): string {
  const left = a.endsWith("/") ? a.slice(0, -1) : a;
  const right = b.startsWith("/") ? b.slice(1) : b;
  return `${left}/${right}`;
}

/**
 * Narrow the walker's root when `opts.path` is set. When `sub` is
 * undefined we just pass `cwd` through; otherwise we resolve the
 * subpath against `cwd` and hand the walker that as its new root.
 *
 * ### Sandboxing is the caller's job
 *
 * `path.resolve` happily resolves an absolute path OR a relative one,
 * so a malicious `../../etc` would escape the sandbox. Callers that
 * accept user input (init-wizard tool adapters) MUST pre-validate
 * via `src/lib/init/tools/shared.ts::safePath` before forwarding to
 * grep/glob. The engine explicitly trusts the passed value.
 */
export function walkerRoot(cwd: string, sub: string | undefined): string {
  if (!sub) {
    return cwd;
  }
  return path.resolve(cwd, sub);
}
