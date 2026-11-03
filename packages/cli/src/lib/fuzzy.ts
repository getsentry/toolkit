/**
 * Fuzzy string matching utilities.
 *
 * Provides Levenshtein edit distance and ranked fuzzy matching for use in
 * shell completions, platform suggestions, and error messages.
 */

/**
 * Compute the Levenshtein edit distance between two strings.
 *
 * Uses dynamic programming with a flat Map for the DP table.
 * Handles empty strings, equal strings, and arbitrary Unicode input.
 *
 * @param a - First string
 * @param b - Second string
 * @returns The minimum number of single-character edits (insert, delete, replace)
 */
export function levenshtein(a: string, b: string): number {
  return editDistance(a, b);
}

/**
 * Return the full-string edit distance, allowing a smaller distance to a
 * non-empty prefix of `b` when it is within `prefixThreshold`.
 *
 * Omit `prefixThreshold` to compare only the complete strings.
 */
function editDistance(a: string, b: string, prefixThreshold?: number): number {
  const m = a.length;
  const n = b.length;
  const dp = new Map<number, number>();
  const key = (i: number, j: number) => i * (n + 1) + j;
  for (let i = 0; i <= m; i++) {
    dp.set(key(i, 0), i);
  }
  for (let j = 0; j <= n; j++) {
    dp.set(key(0, j), j);
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost =
        a[i - 1] === b[j - 1]
          ? (dp.get(key(i - 1, j - 1)) ?? 0)
          : 1 +
            Math.min(
              dp.get(key(i - 1, j - 1)) ?? 0,
              dp.get(key(i - 1, j)) ?? 0,
              dp.get(key(i, j - 1)) ?? 0,
            );
      dp.set(key(i, j), cost);
    }
  }
  let distance = dp.get(key(m, n)) ?? 0;
  if (prefixThreshold !== undefined) {
    const firstLength = Math.max(1, m - prefixThreshold);
    const lastLength = Math.min(n, m + prefixThreshold);
    for (let length = firstLength; length <= lastLength; length++) {
      const prefixDistance = dp.get(key(m, length)) ?? Number.POSITIVE_INFINITY;
      if (prefixDistance <= prefixThreshold) {
        distance = Math.min(distance, prefixDistance);
      }
    }
  }
  return distance;
}

/** Score tiers for fuzzy matching, ordered by relevance. */
const EXACT_SCORE = 0;
const PREFIX_SCORE = 1;
const CONTAINS_SCORE = 2;
/** Fuzzy scores start at this offset so they always rank below contains matches. */
const FUZZY_BASE_SCORE = 3;

/** Options for {@link fuzzyMatch}. */
export type FuzzyMatchOptions = {
  /** Maximum number of results to return (default: unlimited). */
  maxResults?: number;
  /** Search unfinished input; omit to preserve submitted-name matching. */
  mode?: "search";
};

/**
 * Score one candidate as {@link fuzzyMatch} ranks it: lower is better.
 *
 * @returns The score, or `undefined` when the candidate does not match
 */
function matchScore(
  partial: string,
  candidate: string,
  search: boolean,
): number | undefined {
  const lowerPartial = partial.toLowerCase();
  const lowerCandidate = candidate.toLowerCase();
  if (lowerCandidate === lowerPartial) {
    return EXACT_SCORE;
  }
  if (lowerCandidate.startsWith(lowerPartial)) {
    return PREFIX_SCORE;
  }
  if (lowerCandidate.includes(lowerPartial)) {
    return CONTAINS_SCORE;
  }
  if (search && partial.length < 3) {
    return;
  }
  const dist = editDistance(
    lowerPartial,
    lowerCandidate,
    search ? Math.floor(partial.length / 3) : undefined,
  );
  const threshold = Math.max(2, Math.floor(partial.length / 3));
  return dist <= threshold ? FUZZY_BASE_SCORE + dist : undefined;
}

/**
 * Rank candidates by relevance to a partial input string.
 *
 * Scoring strategy (ordered by priority):
 * 1. **Exact match** → score 0 (highest priority)
 * 2. **Prefix match** → score 1 (partial is a prefix of candidate)
 * 3. **Contains match** → score 2 (partial appears as substring)
 * 4. **Fuzzy match** → score 3 + Levenshtein distance (capped by threshold)
 *
 * Threshold: `max(2, floor(partial.length / 3))`. This means `"isseu"`
 * (length 5, threshold 2) matches `"issue"` (distance 2). Candidates
 * beyond the threshold are excluded entirely.
 *
 * Search mode requires literal matches for one- and two-character queries.
 * Longer queries also match candidate prefixes within `floor(length / 3)`
 * edits, without counting the unfinished suffix. Full-name typo tolerance
 * stays unchanged. Use this mode for selectors and incomplete completions,
 * not automatic resolution of submitted names.
 *
 * When `partial` is empty, all candidates are returned (sorted alphabetically).
 *
 * @param partial - The partial input to match against
 * @param candidates - The list of candidate strings
 * @param opts - Optional configuration
 * @returns Candidates sorted by relevance score, then alphabetically
 */
export function fuzzyMatch(
  partial: string,
  candidates: readonly string[],
  opts?: FuzzyMatchOptions,
): string[] {
  if (partial === "") {
    const sorted = [...candidates].sort();
    return opts?.maxResults ? sorted.slice(0, opts.maxResults) : sorted;
  }

  const search = opts?.mode === "search";
  const scored: { candidate: string; score: number }[] = [];
  for (const candidate of candidates) {
    const score = matchScore(partial, candidate, search);
    if (score !== undefined) {
      scored.push({ candidate, score });
    }
  }

  scored.sort(
    (a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate),
  );

  const results = scored.map((s) => s.candidate);
  return opts?.maxResults ? results.slice(0, opts.maxResults) : results;
}

/**
 * Rank candidates made of `.`-joined segments (`span.duration`)
 * by an unfinished input, one segment at a time: the input's Nth segment
 * is matched against the candidate's Nth, as {@link fuzzyMatch} matches in
 * search mode. A candidate needs a segment for each one typed, and can
 * have more after them, so `span.d` finds `span.duration` and
 * `span.description` but never `span.op`, and `span` finds every `span.*`.
 *
 * When `partial` is empty, all candidates are returned (sorted
 * alphabetically).
 *
 * @param partial - The partial input to match against
 * @param candidates - The list of candidate strings
 * @returns Candidates sorted by their summed segment scores, then
 *   alphabetically
 */
export function fuzzyMatchSegments(
  partial: string,
  candidates: readonly string[],
): string[] {
  if (partial === "") {
    return [...candidates].sort();
  }
  const typed = partial.split(".");
  const scored: { candidate: string; score: number }[] = [];
  for (const candidate of candidates) {
    const segments = candidate.split(".");
    if (segments.length < typed.length) {
      continue;
    }
    let score = 0;
    for (const [index, segment] of typed.entries()) {
      const segmentScore =
        segment === ""
          ? PREFIX_SCORE
          : matchScore(segment, segments[index] ?? "", true);
      if (segmentScore === undefined) {
        score = Number.POSITIVE_INFINITY;
        break;
      }
      score += segmentScore;
    }
    if (Number.isFinite(score)) {
      scored.push({ candidate, score });
    }
  }
  scored.sort(
    (a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate),
  );
  return scored.map((s) => s.candidate);
}
