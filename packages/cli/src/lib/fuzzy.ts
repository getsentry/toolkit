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

/** Levenshtein distance between `a` and `b`. */
function editDistance(a: string, b: string): number {
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
  return dp.get(key(m, n)) ?? 0;
}

/** Score tiers for fuzzy matching, ordered by relevance. */
const EXACT_SCORE = 0;
const PREFIX_SCORE = 1;
const CONTAINS_SCORE = 2;
/** Fuzzy scores start at this offset so they always rank below contains and search matches. */
const FUZZY_BASE_SCORE = 3;

// Search mode scores a scatter (the letters in order, apart) or a typo
// against each other on one scale, the same way as the Junior dashboard's
// quick switcher (`quickOpenMatch.ts` in getsentry/junior). Higher is better
// there; `matchScore` maps it between the contains and fuzzy tiers.
const SEARCH_SCALE = 1000;
const WORD_START_BONUS = 10;
// Each character a scatter spreads over costs this much, so `fw` in
// `frontend-web` ranks far above letters strewn across a name.
const SPAN_PENALTY = 20;
// A one-edit typo beats a loose scatter but not a tight one.
const TYPO_SCORE = 600;
// Shorter terms are mostly noise when edited, and need their letters.
const TYPO_MIN_LENGTH = 4;

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
  if (search) {
    const match = searchScore(lowerPartial, lowerCandidate);
    if (match !== undefined) {
      return CONTAINS_SCORE + 1 - match / SEARCH_SCALE;
    }
    // Below that, a long name with more edits than the search typo allows
    // still matches as a whole (`committers` finds `commits`).
    if (partial.length < TYPO_MIN_LENGTH) {
      return;
    }
  }
  const dist = editDistance(lowerPartial, lowerCandidate);
  const threshold = Math.max(2, Math.floor(partial.length / 3));
  return dist <= threshold ? FUZZY_BASE_SCORE + dist : undefined;
}

/** The better of a scatter and a typo match, between 0 and 1000. */
function searchScore(partial: string, candidate: string): number | undefined {
  const scatter = scatterScore(partial, candidate);
  // No typo can beat a scatter this tight, so skip the edit distances.
  if (scatter !== undefined && scatter >= TYPO_SCORE) {
    return scatter;
  }
  const typo = typoScore(partial, candidate);
  if (scatter === undefined || typo === undefined) {
    return scatter ?? typo;
  }
  return Math.max(scatter, typo);
}

function scatterScore(partial: string, candidate: string): number | undefined {
  let first = -1;
  let last = -1;
  let wordStarts = 0;
  let from = 0;
  for (const char of partial) {
    const at = candidate.indexOf(char, from);
    if (at === -1) {
      return;
    }
    if (isWordStart(candidate, at)) {
      wordStarts += 1;
    }
    if (first === -1) {
      first = at;
    }
    last = at;
    from = at + char.length;
  }
  const score =
    SEARCH_SCALE -
    (last - first) * SPAN_PENALTY +
    wordStarts * WORD_START_BONUS;
  return Math.min(Math.max(score, 1), SEARCH_SCALE - 1);
}

/**
 * Compare `partial` with the text from each word start, so an unfinished
 * word still counts. Allows one edit for short input and two for longer input.
 */
function typoScore(partial: string, candidate: string): number | undefined {
  if (partial.length < TYPO_MIN_LENGTH) {
    return;
  }
  const allowed = partial.length < 6 ? 1 : 2;
  let best: { at: number; distance: number } | undefined;
  // Compare against the rest of the candidate, not only the word, so
  // `sentyr-javascrpt` still finds `sentry-javascript`.
  for (const word of candidate.matchAll(WORD_RE)) {
    const distances = prefixDistances(
      partial,
      candidate.slice(word.index, word.index + partial.length + allowed),
    );
    // Each extra or missing letter costs an edit, so lengths further than
    // `allowed` from the input can't match.
    for (let offset = -allowed; offset <= allowed; offset++) {
      const distance = distances[partial.length + offset];
      if (
        distance !== undefined &&
        distance <= allowed &&
        (!best || distance < best.distance)
      ) {
        best = { at: word.index, distance };
      }
    }
  }
  return best && Math.max(TYPO_SCORE / best.distance - best.at, 1);
}

const WORD_RE = /[\p{L}\p{N}]+/gu;
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;

function isWordStart(text: string, at: number): boolean {
  return at === 0 || !WORD_CHAR_RE.test(text[at - 1] ?? "");
}

/**
 * Edit distance from `a` to each prefix of `b`, where swapping two neighbors
 * costs one edit. Keeps three rows: the swap looks two rows back.
 */
function prefixDistances(a: string, b: string): number[] {
  let before = Array.from({ length: b.length + 1 }, () => 0);
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  let current = Array.from({ length: b.length + 1 }, () => 0);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        current[j] = Math.min(current[j] ?? 0, (before[j - 2] ?? 0) + 1);
      }
    }
    [before, previous, current] = [previous, current, before];
  }
  return previous;
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
 * Search mode is for unfinished input in selectors, filters, and
 * completions. Between the contains and fuzzy tiers, it ranks the better of
 * two matches:
 * - **Scatter**: the letters appear in order but apart, so `fw` finds
 *   `frontend-web`. A tight scatter ranks higher.
 * - **Typo**: four or more characters within one edit of a word's start,
 *   or two edits from six characters on. Swapping two neighbors counts as
 *   one edit, so `isseu` finds `issue` and `frone` finds `frontend-web`.
 *   A typo beats a loose scatter but not a tight one.
 *
 * The fuzzy tier still applies in search mode from four characters on.
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
