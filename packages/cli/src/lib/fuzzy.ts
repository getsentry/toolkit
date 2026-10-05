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
              dp.get(key(i, j - 1)) ?? 0
            );
      dp.set(key(i, j), cost);
    }
  }
  return dp.get(key(m, n)) ?? 0;
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
};

/**
 * Rank candidates by relevance to a partial input string.
 *
 * Scoring strategy (ordered by priority):
 * 1. **Exact match** → score 0 (highest priority)
 * 2. **Prefix match** → score 1 (partial is a prefix of candidate)
 * 3. **Contains match** → score 2 (partial appears as substring)
 * 4. **Fuzzy match** → score 3 + Levenshtein distance (capped by threshold)
 *
 * Threshold: `max(2, floor(partial.length / 3))`. This means `"tnry"`
 * (length 4, threshold 2) matches `"sentry"` (distance 2). Candidates
 * beyond the threshold are excluded entirely.
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
  opts?: FuzzyMatchOptions
): string[] {
  if (partial === "") {
    const sorted = [...candidates].sort();
    return opts?.maxResults ? sorted.slice(0, opts.maxResults) : sorted;
  }

  const lowerPartial = partial.toLowerCase();
  const threshold = Math.max(2, Math.floor(partial.length / 3));
  const scored: { candidate: string; score: number }[] = [];

  for (const candidate of candidates) {
    const lowerCandidate = candidate.toLowerCase();

    if (lowerCandidate === lowerPartial) {
      scored.push({ candidate, score: EXACT_SCORE });
    } else if (lowerCandidate.startsWith(lowerPartial)) {
      scored.push({ candidate, score: PREFIX_SCORE });
    } else if (lowerCandidate.includes(lowerPartial)) {
      scored.push({ candidate, score: CONTAINS_SCORE });
    } else {
      const dist = levenshtein(lowerPartial, lowerCandidate);
      if (dist <= threshold) {
        scored.push({ candidate, score: FUZZY_BASE_SCORE + dist });
      }
    }
  }

  scored.sort(
    (a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate)
  );

  const results = scored.map((s) => s.candidate);
  return opts?.maxResults ? results.slice(0, opts.maxResults) : results;
}
