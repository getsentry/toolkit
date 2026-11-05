/**
 * Search the docs.sentry.io page index without a model.
 *
 * Queries are plain words and optional regular expressions, the two things
 * agents already know. Words are ranked: a page that matches more of them
 * ranks higher, but no page has to match all of them, so a long query such as
 * "tracing cloudflare tanstack start" still returns something. Regular
 * expressions (`-e`) filter by page title or URL path, like `grep -e`.
 *
 * Input is normalized so that the ways agents quote, punctuate, and paste
 * queries all mean the same thing: quote characters are spaces, case and
 * punctuation are ignored, `next.js` / `next js` / `nextjs` are one word, and
 * a pasted docs URL returns that page.
 *
 * @module
 */

/** The public origin of the Sentry documentation. */
export const DOCS_ORIGIN = "https://docs.sentry.io";

/** One documentation page in the search index. */
export type DocsIndexPage = {
  /** Canonical path without a trailing slash, such as `/platforms/python`. */
  readonly path: string;
  readonly title: string;
  readonly description: string;
  /** Index of the parent page in {@link DocsIndex.pages}, or -1. */
  readonly parent: number;
};

/**
 * Where a token appears on a page. A posting packs a page index and the sum
 * of these flags into one number: `page * FIELD_COUNT_SPAN + flags`.
 */
const FIELD = {
  title: 1,
  /** A whole path segment with `-`/`_` removed: `react-native` → `reactnative`. */
  segment: 2,
  path: 4,
  description: 8,
  breadcrumb: 16,
} as const;
const FIELD_COUNT_SPAN = 32;

/**
 * Token → postings (see {@link FIELD}), built once when the index is
 * downloaded so that a search only reads the lists of its own words.
 */
export type DocsPostings = Readonly<Record<string, readonly number[]>>;

/** The pages that `sentry docs` searches, with their inverted index. */
export type DocsIndex = {
  readonly pages: readonly DocsIndexPage[];
  readonly postings: DocsPostings;
};

/** One search result. */
export type DocsSearchResult = {
  readonly title: string;
  readonly description: string;
  /** The page's Markdown URL, which agents can fetch directly. */
  readonly url: string;
  readonly breadcrumbs: string[];
};

export type DocsSearchOptions = {
  /** Words to rank pages by. */
  readonly query: string;
  /** Regular expressions; a page must match one of them. */
  readonly patterns?: readonly string[];
  readonly limit: number;
};

export type DocsSearchOutcome = {
  readonly results: DocsSearchResult[];
  /** What the search changed about the input, such as a corrected typo. */
  readonly warnings: string[];
};

/** Quote characters agents and shells leave in arguments, including curly quotes. */
const QUOTE_CLASS =
  "['\"`\u2018\u2019\u201a\u201b\u201c\u201d\u201e\u201f\u00ab\u00bb]";
const QUOTE_CHARS_RE = new RegExp(QUOTE_CLASS, "g");
const WRAPPING_QUOTES_RE = new RegExp(`^${QUOTE_CLASS}+|${QUOTE_CLASS}+$`, "g");
/** `next.js`, `nuxt.js`, `node.js` → `nextjs`, `nuxtjs`, `nodejs`. */
const DOT_JS_RE = /([a-z0-9])\.js\b/g;
const TOKEN_RE = /[a-z0-9]+/g;
const DOCS_URL_PREFIX_RE = /^(?:https?:\/\/)?docs\.sentry\.io(?=\/|$)/i;
const SLASH_DELIMITED_RE = /^\/(.+)\/[a-z]*$/s;
const TRAILING_MD_RE = /(?:\\?\.md|\/)+$/i;
const SEGMENT_JOIN_RE = /[-_.]/g;
/** `/platforms/<platform>/` and an optional `/guides/<guide>/` after it. */
const PLATFORM_GUIDE_RE = /^\/platforms\/([^/]+)(?:\/guides\/([^/]+))?/;

/**
 * Words that carry no meaning in a docs search. `add` is here because agents
 * ask to "add Sentry to <framework>", and as a search word it only matches
 * descriptions ("add data to events"). Domain words such as `use` and `logs`
 * are deliberately not here.
 */
const FILLER_WORDS = new Set([
  "a",
  "add",
  "an",
  "and",
  "are",
  "can",
  "do",
  "does",
  "for",
  "how",
  "i",
  "in",
  "is",
  "me",
  "my",
  "of",
  "on",
  "the",
  "to",
  "what",
  "with",
]);

/**
 * Words that do not narrow a search, searched only when nothing else is
 * left: every page is about Sentry, and each platform's main page is its
 * setup guide, so "set up sentry in a django app" means "django".
 */
const GENERIC_WORDS = new Set([
  "app",
  "application",
  "docs",
  "documentation",
  "get",
  "install",
  "sentry",
  "set",
  "setup",
  "started",
  "up",
]);

/**
 * Leading words that the removed `docs list` / `docs query` / `docs search`
 * subcommands used, so old invocations keep working.
 */
const LEGACY_SUBCOMMANDS = new Set(["list", "query", "search"]);

/** A word at least this long that matches nothing is checked for a typo. */
const MIN_TYPO_LENGTH = 5;
/** A word at least this long also matches longer words that start with it. */
const MIN_PREFIX_LENGTH = 4;

const FIELD_WEIGHT = {
  title: 3,
  segment: 2.5,
  path: 1.5,
  description: 1,
  breadcrumb: 1,
  prefix: 0.5,
} as const;

/** Lowercase, drop quote characters, and join `x.js` into one word. */
function normalizeText(text: string): string {
  return text
    .replace(QUOTE_CHARS_RE, " ")
    .toLowerCase()
    .replace(DOT_JS_RE, "$1js");
}

/** Split text into lowercase alphanumeric tokens. */
function tokenize(text: string): string[] {
  return normalizeText(text).match(TOKEN_RE) ?? [];
}

/** The titles of a page's ancestors, nearest last. */
function breadcrumbsOf(
  pages: readonly DocsIndexPage[],
  index: number,
): string[] {
  const crumbs: string[] = [];
  let parent = pages[index]?.parent ?? -1;
  // A malformed index could contain a cycle; the depth bound stops it.
  for (let depth = 0; parent >= 0 && depth < 32; depth += 1) {
    const page = pages[parent];
    if (!page) {
      break;
    }
    if (page.title && page.path !== "/") {
      crumbs.unshift(page.title);
    }
    parent = page.parent;
  }
  return crumbs;
}

/** Whether a posting's flags include a {@link FIELD}. */
function hasField(flags: number, field: number): boolean {
  return Math.floor(flags / field) % 2 === 1;
}

/** Build the inverted index of a page list. */
export function buildPostings(pages: readonly DocsIndexPage[]): DocsPostings {
  const postings: Record<string, number[]> = Object.create(null);
  pages.forEach((page, i) => {
    const fields = new Map<string, number>();
    const add = (tokens: Iterable<string>, field: number): void => {
      for (const token of tokens) {
        const flags = fields.get(token) ?? 0;
        fields.set(token, hasField(flags, field) ? flags : flags + field);
      }
    };
    add(tokenize(page.title), FIELD.title);
    add(
      page.path
        .split("/")
        .filter(Boolean)
        .map((segment) => segment.toLowerCase().replace(SEGMENT_JOIN_RE, "")),
      FIELD.segment,
    );
    add(tokenize(page.path), FIELD.path);
    add(tokenize(page.description), FIELD.description);
    add(tokenize(breadcrumbsOf(pages, i).join(" ")), FIELD.breadcrumb);
    for (const [token, bits] of fields) {
      const list = postings[token] ?? [];
      list.push(i * FIELD_COUNT_SPAN + bits);
      postings[token] = list;
    }
  });
  return postings;
}

/** Whether two words differ by one edit (insert, delete, substitute, swap). */
function isOneEditAway(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) {
    return false;
  }
  if (a.length === b.length) {
    const diffs: number[] = [];
    for (let i = 0; i < a.length && diffs.length <= 2; i += 1) {
      if (a[i] !== b[i]) {
        diffs.push(i);
      }
    }
    if (diffs.length === 1) {
      return true;
    }
    const [first, second] = diffs;
    return (
      diffs.length === 2 &&
      first !== undefined &&
      second === first + 1 &&
      a[first] === b[second] &&
      a[second] === b[first]
    );
  }
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < shorter.length && shorter[i] === longer[i]) {
    i += 1;
  }
  return shorter.slice(i) === longer.slice(i + 1);
}

/** One query word and the index words that count as it. */
type Term = {
  readonly word: string;
  readonly alternatives: readonly string[];
};

/** A search's view of the index: the vocabulary, computed once. */
type SearchContext = {
  readonly index: DocsIndex;
  readonly vocabulary: readonly string[];
};

function frequency(index: DocsIndex, token: string): number {
  return index.postings[token]?.length ?? 0;
}

/** Index words longer than `word` that start with it. */
function wordsStartingWith(context: SearchContext, word: string): string[] {
  if (word.length < MIN_PREFIX_LENGTH) {
    return [];
  }
  return context.vocabulary.filter(
    (token) => token.length > word.length && token.startsWith(word),
  );
}

/** The index word one edit from `word` that the most pages contain. */
function correctTypo(context: SearchContext, word: string): string | undefined {
  let best: { token: string; count: number } | undefined;
  for (const token of context.vocabulary) {
    if (token[0] !== word[0] || !isOneEditAway(word, token)) {
      continue;
    }
    const count = frequency(context.index, token);
    if (!best || count > best.count) {
      best = { token, count };
    }
  }
  return best?.token;
}

/** Turn query words into terms: joined pairs, typo corrections. */
function buildTerms(
  context: SearchContext,
  words: readonly string[],
  warnings: string[],
): Term[] {
  const alternatives = words.map((word) => new Set([word]));
  for (let i = 0; i + 1 < words.length; i += 1) {
    const joined = `${words[i]}${words[i + 1]}`;
    if (frequency(context.index, joined) > 0) {
      alternatives[i]?.add(joined);
      alternatives[i + 1]?.add(joined);
    }
  }
  return words.map((word, i) => {
    const alts = alternatives[i] ?? new Set([word]);
    const known =
      [...alts].some((alt) => frequency(context.index, alt) > 0) ||
      wordsStartingWith(context, word).length > 0;
    if (!known && word.length >= MIN_TYPO_LENGTH) {
      const corrected = correctTypo(context, word);
      if (corrected) {
        alts.add(corrected);
        warnings.push(`Searched "${corrected}" for "${word}".`);
      }
    }
    return { word, alternatives: [...alts] };
  });
}

/** Inverse document frequency: rare words count more than common ones. */
function idf(index: DocsIndex, token: string): number {
  return Math.log((index.pages.length + 1) / (frequency(index, token) + 1)) + 1;
}

/** Fields from most to least telling. */
const FIELDS_BY_WEIGHT = [
  [FIELD.title, FIELD_WEIGHT.title],
  [FIELD.segment, FIELD_WEIGHT.segment],
  [FIELD.path, FIELD_WEIGHT.path],
  [FIELD.description, FIELD_WEIGHT.description],
  [FIELD.breadcrumb, FIELD_WEIGHT.breadcrumb],
] as const;

/** The weight of the best field in a posting's flags. */
function fieldWeight(flags: number): number {
  const weight =
    FIELDS_BY_WEIGHT.find(([field]) => hasField(flags, field))?.[1] ?? 0;
  // A word that is a whole path segment (`react` in `/guides/react/`) beats
  // one that is only part of it (`react` in `/react-native/`).
  return hasField(flags, FIELD.segment)
    ? weight + FIELD_WEIGHT.segment
    : weight;
}

/** The best score of one term on each page it matches. */
function scoreTerm(context: SearchContext, term: Term): Map<number, number> {
  const scores = new Map<number, number>();
  const add = (token: string, weightOf: (bits: number) => number): void => {
    const tokenIdf = idf(context.index, token);
    for (const posting of context.index.postings[token] ?? []) {
      const page = Math.floor(posting / FIELD_COUNT_SPAN);
      const score = weightOf(posting % FIELD_COUNT_SPAN) * tokenIdf;
      if (score > (scores.get(page) ?? 0)) {
        scores.set(page, score);
      }
    }
  };
  for (const alt of term.alternatives) {
    add(alt, fieldWeight);
    for (const longer of wordsStartingWith(context, alt)) {
      add(longer, () => FIELD_WEIGHT.prefix);
    }
  }
  return scores;
}

/** Normalize and compile one `-e` pattern, or return why it is invalid. */
function compilePattern(raw: string): RegExp | SyntaxError {
  // Quotes that survived the shell around the whole pattern.
  let source = raw.trim().replace(WRAPPING_QUOTES_RE, "").trim();
  const delimited = SLASH_DELIMITED_RE.exec(source);
  if (delimited?.[1]) {
    source = delimited[1];
  }
  source = source.replace(DOCS_URL_PREFIX_RE, "");
  if (source.length > 1) {
    source = source.replace(TRAILING_MD_RE, "") || source;
  }
  try {
    return new RegExp(source, "i");
  } catch (error) {
    return error instanceof SyntaxError
      ? error
      : new SyntaxError(String(error));
  }
}

/** Normalize a pasted docs URL or path to an index path. */
function toDocsPath(input: string): string | undefined {
  const trimmed = input.replace(QUOTE_CHARS_RE, "").trim();
  if (!trimmed || /\s/.test(trimmed)) {
    return;
  }
  const withoutOrigin = trimmed.replace(DOCS_URL_PREFIX_RE, "");
  if (withoutOrigin === trimmed && !trimmed.startsWith("/")) {
    return;
  }
  const path = withoutOrigin
    .split(/[?#]/)[0]
    ?.replace(TRAILING_MD_RE, "")
    .replace(/\/{2,}/g, "/");
  if (path === undefined) {
    return;
  }
  return path.startsWith("/") ? path || "/" : `/${path}`;
}

/** The Markdown URL of a page. */
function markdownUrl(path: string): string {
  return path === "/" ? `${DOCS_ORIGIN}/index.md` : `${DOCS_ORIGIN}${path}.md`;
}

function toResult(index: DocsIndex, i: number): DocsSearchResult {
  const page = index.pages[i] as DocsIndexPage;
  return {
    title: page.title,
    description: page.description,
    url: markdownUrl(page.path),
    breadcrumbs: breadcrumbsOf(index.pages, i),
  };
}

/**
 * Pages that repeat across guides (the Vite source-map page exists under
 * every JavaScript guide) collapse to one result unless the query names the
 * guide. Returns `undefined` when the page should never collapse.
 */
function duplicateKey(
  page: DocsIndexPage,
  askedWords: ReadonlySet<string>,
): string | undefined {
  const match = PLATFORM_GUIDE_RE.exec(page.path);
  if (!match) {
    return;
  }
  const [prefix, platform, guide] = match;
  if (guide) {
    const joined = guide.replace(SEGMENT_JOIN_RE, "");
    const parts = guide.split(SEGMENT_JOIN_RE);
    if (askedWords.has(joined) || parts.some((part) => askedWords.has(part))) {
      return;
    }
  }
  return `${platform}\u0000${page.title}\u0000${page.path.slice(prefix.length)}`;
}

/** Split the query into words, dropping legacy subcommands and filler. */
function queryWords(query: string): string[] {
  const words = tokenize(query);
  if (words.length > 1 && LEGACY_SUBCOMMANDS.has(words[0] ?? "")) {
    words.shift();
  }
  const kept = words.filter((word) => !FILLER_WORDS.has(word));
  const specific = kept.filter((word) => !GENERIC_WORDS.has(word));
  return [...new Set(specific.length > 0 ? specific : kept)];
}

/** Search the index. */
export function searchDocs(
  index: DocsIndex,
  options: DocsSearchOptions,
): DocsSearchOutcome {
  const warnings: string[] = [];
  let query = options.query;

  // A pasted docs URL or path returns that page.
  const pastedPath = toDocsPath(query);
  if (pastedPath !== undefined && !options.patterns?.length) {
    const exact = index.pages.findIndex((page) => page.path === pastedPath);
    if (exact >= 0) {
      return { results: [toResult(index, exact)], warnings };
    }
  }

  const regexes: RegExp[] = [];
  for (const pattern of options.patterns ?? []) {
    const compiled = compilePattern(pattern);
    if (compiled instanceof RegExp) {
      regexes.push(compiled);
    } else {
      warnings.push(
        `"${pattern}" is not a valid regular expression (${compiled.message}); searched its words instead.`,
      );
      query = `${query} ${pattern}`;
    }
  }
  const allowed =
    regexes.length > 0
      ? index.pages.map((page) =>
          regexes.some(
            (regex) => regex.test(page.path) || regex.test(page.title),
          ),
        )
      : undefined;

  const context: SearchContext = {
    index,
    vocabulary: Object.keys(index.postings),
  };
  const words = queryWords(query);
  if (words.length === 0 && regexes.length === 0) {
    warnings.push(
      'The query has no topic words; add one, such as "nextjs tracing".',
    );
    return { results: [], warnings };
  }
  const terms = buildTerms(context, words, warnings);

  const totals = new Map<number, { matched: number; score: number }>();
  if (terms.length === 0) {
    allowed?.forEach((ok, page) => {
      if (ok) {
        totals.set(page, { matched: 0, score: 0 });
      }
    });
  }
  for (const term of terms) {
    for (const [page, score] of scoreTerm(context, term)) {
      if (allowed && !allowed[page]) {
        continue;
      }
      const total = totals.get(page) ?? { matched: 0, score: 0 };
      total.matched += 1;
      total.score += score;
      totals.set(page, total);
    }
  }

  // Shallower pages (overviews, setup) win ties over deep sub-pages.
  const ranked = [...totals].map(([page, total]) => ({
    page,
    matched: total.matched,
    score:
      total.score - (index.pages[page]?.path.split("/").length ?? 0) * 0.05,
  }));
  ranked.sort(
    (a, b) =>
      b.matched - a.matched ||
      b.score - a.score ||
      (index.pages[a.page]?.path ?? "").localeCompare(
        index.pages[b.page]?.path ?? "",
      ),
  );

  const askedWords = new Set(terms.flatMap((term) => term.alternatives));
  const results: DocsSearchResult[] = [];
  const seen = new Set<string>();
  for (const { page } of ranked) {
    if (results.length >= options.limit) {
      break;
    }
    const key =
      regexes.length > 0
        ? undefined
        : duplicateKey(index.pages[page] as DocsIndexPage, askedWords);
    if (key !== undefined) {
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
    }
    results.push(toResult(index, page));
  }
  return { results, warnings };
}
