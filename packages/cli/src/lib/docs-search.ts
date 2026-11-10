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
/**
 * A JavaScript regex literal such as `/a\/b$/i`: a body with no unescaped
 * `/` and only real flags after it, which tells it apart from a docs path
 * such as `/python/integrations/django` or `/guides/nextjs`.
 */
const SLASH_DELIMITED_RE = /^\/((?:[^/\\]|\\.)+)\/[dgimsuvy]*$/s;
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
 * Generic words that still say something next to specific words: "nextjs
 * setup" means the setup page. They break ties between pages that match the
 * same specific words.
 */
const SETUP_WORDS = new Set(["install", "set", "setup", "started", "up"]);

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
  /** A page of the platform that a word such as `django` points to. */
  platform: 0.75,
  prefix: 0.5,
} as const;

/**
 * Breaks ties between pages that match the same words by how much of the
 * title they cover: "Set Up Tracing" over "Set Up Agent Tracing".
 */
const TITLE_COVERAGE_WEIGHT = 1;

/** Endings that make one word another form of it: `filter` → `filtering`. */
const INFLECTIONS = ["s", "es", "ing", "ed", "er", "ers"];
/** How much another form of a word counts, compared with the word itself. */
const FORM_FACTOR = 0.9;
/** How much a generic word such as `setup` counts next to specific words. */
const WEAK_FACTOR = 0.3;

/**
 * Sections that only answer a query that asks for them: API reference pages
 * repeat product topics ("Create an Alert for an Organization"), and SDK
 * migration guides repeat feature names ("New Tracing APIs").
 */
const NICHE_SECTIONS = [
  {
    matches: (path: string) => path === "/api" || path.startsWith("/api/"),
    words: new Set(["api", "apis", "endpoint", "endpoints", "rest"]),
  },
  {
    matches: (path: string) => path.includes("/migration"),
    words: new Set([
      "migrate",
      "migrating",
      "migration",
      "upgrade",
      "upgrading",
    ]),
  },
];
const NICHE_SECTION_FACTOR = 0.6;

/** The share of a word's path segments in one platform that points to it. */
const PLATFORM_SHARE = 0.8;

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
  /** The alternatives that are other forms of the word: `event` for `events`. */
  readonly forms: ReadonlySet<string>;
};

/** A search's view of the index: the vocabulary, computed once. */
type SearchContext = {
  readonly index: DocsIndex;
  readonly vocabulary: readonly string[];
};

/**
 * The postings of a token. Own properties only: an index parsed from the
 * cache inherits `Object.prototype`, so `constructor` must not resolve.
 */
function postingsOf(index: DocsIndex, token: string): readonly number[] {
  return Object.hasOwn(index.postings, token)
    ? (index.postings[token] ?? [])
    : [];
}

function frequency(index: DocsIndex, token: string): number {
  return postingsOf(index, token).length;
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

/**
 * Whether `longer` is `word` with an inflection: `filter` → `filtering`,
 * `scrub` → `scrubbing`, `create` → `creating`.
 */
function isInflection(word: string, longer: string): boolean {
  const stems = word.endsWith("e") ? [word, word.slice(0, -1)] : [word];
  return stems.some((stem) => {
    if (longer.length <= stem.length || !longer.startsWith(stem)) {
      return false;
    }
    const suffix = longer.slice(stem.length);
    // A doubled final consonant: `scrub` → `scrubbing`.
    const undoubled = suffix[0] === stem.at(-1) ? suffix.slice(1) : "";
    return INFLECTIONS.includes(suffix) || INFLECTIONS.includes(undoubled);
  });
}

/** Possible base forms of a word: `events` → `event`, `creating` → `create`. */
function baseForms(word: string): string[] {
  const forms: string[] = [];
  for (const suffix of INFLECTIONS) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      const stem = word.slice(0, -suffix.length);
      forms.push(stem, `${stem}e`);
      if (stem.at(-1) === stem.at(-2)) {
        forms.push(stem.slice(0, -1));
      }
    }
  }
  return forms;
}

/** Other forms of a word that the index contains. */
function formsOf(context: SearchContext, word: string): string[] {
  const bases = baseForms(word).filter(
    (base) => frequency(context.index, base) > 0,
  );
  const forms = new Set(bases);
  for (const base of [word, ...bases]) {
    for (const token of context.vocabulary) {
      if (isInflection(base, token)) {
        forms.add(token);
      }
    }
  }
  forms.delete(word);
  return [...forms];
}

/** Turn query words into terms: joined pairs, other forms, typo fixes. */
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
    const forms = new Set(
      formsOf(context, word).filter((form) => !alts.has(form)),
    );
    for (const form of forms) {
      alts.add(form);
    }
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
    return { word, alternatives: [...alts], forms };
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

/**
 * The weight of the best field in a posting's flags. A whole path segment
 * (`react` in `/guides/react/`) beats part of one (`react` in
 * `/react-native/`) because segment ranks above path.
 */
function fieldWeight(flags: number): number {
  return FIELDS_BY_WEIGHT.find(([field]) => hasField(flags, field))?.[1] ?? 0;
}

/** The best score of one term on each page it matches. */
function scoreTerm(context: SearchContext, term: Term): Map<number, number> {
  const scores = new Map<number, number>();
  // Another form of the word counts as rare as the word itself, and a bit
  // less than it: "sessions" must not beat "session" for being rarer.
  const wordKnown = frequency(context.index, term.word) > 0;
  const add = (token: string, weightOf: (bits: number) => number): void => {
    const tokenIdf =
      term.forms.has(token) && wordKnown
        ? idf(context.index, term.word) * FORM_FACTOR
        : idf(context.index, token);
    for (const posting of postingsOf(context.index, token)) {
      const page = Math.floor(posting / FIELD_COUNT_SPAN);
      const score = weightOf(posting % FIELD_COUNT_SPAN) * tokenIdf;
      if (score > (scores.get(page) ?? 0)) {
        scores.set(page, score);
      }
    }
  };
  const alternatives = new Set(term.alternatives);
  for (const alt of alternatives) {
    add(alt, fieldWeight);
    for (const longer of wordsStartingWith(context, alt)) {
      if (!alternatives.has(longer)) {
        add(longer, () => FIELD_WEIGHT.prefix);
      }
    }
  }
  return scores;
}

/** What a query word says about the platform. */
type PlatformHint = {
  readonly platform: string;
  /** The word is the platform or one of its guides, so paths contain it. */
  readonly inPath: boolean;
  /** Some of the word's pages are under a guide, such as a JavaScript framework. */
  readonly inGuide: boolean;
};

/**
 * The platform a term points to: `python`, `nextjs` (a JavaScript guide),
 * or `django`, whose pages are all under `/platforms/python/`.
 */
function platformHint(
  context: SearchContext,
  term: Term,
): PlatformHint | undefined {
  const counts = new Map<string, number>();
  const guidePlatforms = new Set<string>();
  let total = 0;
  let inGuide = false;
  // The word is a platform: `android`, whose name also appears in other
  // platforms' paths (`/platforms/dotnet/guides/android`).
  let named: string | undefined;
  for (const alt of term.alternatives) {
    for (const posting of postingsOf(context.index, alt)) {
      if (!hasField(posting % FIELD_COUNT_SPAN, FIELD.segment)) {
        continue;
      }
      total += 1;
      const page = context.index.pages[Math.floor(posting / FIELD_COUNT_SPAN)];
      const match = PLATFORM_GUIDE_RE.exec(page?.path ?? "");
      if (!match?.[1]) {
        continue;
      }
      const [prefix, platform, guide] = match;
      counts.set(platform, (counts.get(platform) ?? 0) + 1);
      inGuide ||= guide !== undefined;
      if (platform.replace(SEGMENT_JOIN_RE, "") === alt) {
        if (page?.path === prefix) {
          named = platform;
        }
      } else if (guide?.replace(SEGMENT_JOIN_RE, "") === alt) {
        guidePlatforms.add(platform);
      }
    }
  }
  if (named) {
    return { platform: named, inPath: true, inGuide };
  }
  let best: [string, number] | undefined;
  for (const entry of counts) {
    if (!best || entry[1] > best[1]) {
      best = entry;
    }
  }
  // A guide name that is also a topic everywhere (Rust has a `tracing`
  // guide) does not point to a platform; one such as `nextjs` does.
  if (!best || best[1] < total * PLATFORM_SHARE) {
    return;
  }
  return {
    platform: best[0],
    inPath: guidePlatforms.has(best[0]),
    inGuide,
  };
}

/**
 * A word such as `django` or `fastapi`, an integration page of one platform,
 * also matches that platform's other pages at a low weight, so "fastapi
 * profiling" finds Python profiling rather than every platform's. Words
 * that are a platform or guide (`python`, `nextjs`) are already in the
 * paths, and so is a platform that another query word names.
 */
function scorePlatformPages(
  context: SearchContext,
  term: Term,
  hint: PlatformHint,
  hints: readonly (PlatformHint | undefined)[],
  scores: Map<number, number>,
): void {
  if (
    hint.inPath ||
    hint.inGuide ||
    hints.some((other) => other?.inPath && other.platform === hint.platform)
  ) {
    return;
  }
  const prefix = `/platforms/${hint.platform}/`;
  const score = FIELD_WEIGHT.platform * idf(context.index, term.word);
  context.index.pages.forEach((page, i) => {
    if (!scores.has(i) && page.path.startsWith(prefix)) {
      scores.set(i, score);
    }
  });
}

/** How much of a page's title the query covers, from 0 to 1. */
function titleCoverage(title: string, askedWords: ReadonlySet<string>): number {
  const words = tokenize(title).filter(
    (word) => !FILLER_WORDS.has(word) && !GENERIC_WORDS.has(word),
  );
  if (words.length === 0) {
    return 0;
  }
  return words.filter((word) => askedWords.has(word)).length / words.length;
}

/** Lower the score of a section page the query does not ask for. */
function sectionFactor(path: string, askedWords: ReadonlySet<string>): number {
  for (const section of NICHE_SECTIONS) {
    if (
      section.matches(path) &&
      ![...section.words].some((word) => askedWords.has(word))
    ) {
      return NICHE_SECTION_FACTOR;
    }
  }
  return 1;
}

/**
 * The quantifier at `i`: where it ends, whether it can match its atom more
 * than once, and whether the number of matches varies.
 */
function quantifierAt(
  source: string,
  i: number,
): { end: number; repeats: boolean; varies: boolean } {
  const char = source[i];
  let end = i;
  let repeats = false;
  let varies = false;
  if (char === "*" || char === "+") {
    end = i + 1;
    repeats = true;
    varies = true;
  } else if (char === "?") {
    end = i + 1;
    varies = true;
  } else if (char === "{") {
    const braces = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i));
    if (braces) {
      end = i + braces[0].length;
      const [, min, comma, max] = braces;
      const most = comma
        ? max
          ? Number(max)
          : Number.POSITIVE_INFINITY
        : Number(min);
      repeats = most > 1;
      varies = most !== Number(min);
    }
  }
  // A lazy `?` after a quantifier.
  if (end > i && source[end] === "?") {
    end += 1;
  }
  return { end, repeats, varies };
}

/** The index after a `[...]` character class that starts at `i`. */
function endOfClass(source: string, i: number): number {
  let j = i + 1;
  if (source[j] === "^") {
    j += 1;
  }
  // A `]` right after `[` or `[^` is a literal.
  if (source[j] === "]") {
    j += 1;
  }
  while (j < source.length && source[j] !== "]") {
    j += source[j] === "\\" ? 2 : 1;
  }
  return j + 1;
}

/** The index after the `?:`, `?=`, `?<name>`, … prefix of a group at `i`. */
function afterGroupPrefix(source: string, i: number): number {
  if (source[i + 1] !== "?") {
    return i + 1;
  }
  if (source[i + 2] === "<" && source[i + 3] !== "=" && source[i + 3] !== "!") {
    const close = source.indexOf(">", i + 3);
    return close >= 0 ? close + 1 : i + 3;
  }
  return source[i + 2] === "<" ? i + 4 : i + 3;
}

/**
 * Whether a pattern repeats a group that can match the same text in several
 * ways, such as `(a+)+`, `(.*a){20}`, or `(.|\s)*`. On a page that does not
 * match, the regex engine tries every way, which takes exponential time, so
 * one such `-e` would hang the command. A group is ambiguous when it holds a
 * variable repeat, an alternation, or a backreference.
 */
function repeatsAmbiguousGroup(source: string): boolean {
  const stack: { ambiguous: boolean }[] = [{ ambiguous: false }];
  let i = 0;
  while (i < source.length) {
    const top = stack.at(-1) as { ambiguous: boolean };
    const char = source[i];
    if (char === "(") {
      stack.push({ ambiguous: false });
      i = afterGroupPrefix(source, i);
      continue;
    }
    if (char === ")") {
      const group = stack.length > 1 ? (stack.pop() as typeof top) : top;
      const quantifier = quantifierAt(source, i + 1);
      if (quantifier.repeats && group.ambiguous) {
        return true;
      }
      const parent = stack.at(-1) as typeof top;
      parent.ambiguous ||= group.ambiguous || quantifier.varies;
      i = Math.max(quantifier.end, i + 1);
      continue;
    }
    if (char === "|") {
      top.ambiguous = true;
      i += 1;
      continue;
    }
    let atomEnd = i + 1;
    if (char === "[") {
      atomEnd = endOfClass(source, i);
    } else if (char === "\\") {
      const next = source[i + 1] ?? "";
      if (/[1-9k]/.test(next)) {
        top.ambiguous = true;
      }
      atomEnd = i + 2;
      if ("pPu".includes(next) && source[atomEnd] === "{") {
        atomEnd = source.indexOf("}", atomEnd) + 1 || source.length;
      }
    }
    const quantifier = quantifierAt(source, atomEnd);
    top.ambiguous ||= quantifier.varies;
    i = Math.max(quantifier.end, atomEnd);
  }
  return false;
}

/** Normalize and compile one `-e` pattern, or return why it is unusable. */
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
    const regex = new RegExp(source, "i");
    if (repeatsAmbiguousGroup(source)) {
      return new SyntaxError(
        "it repeats a group that can match the same text in several ways, such as (a+)+, which can take minutes to run; use a single repeat such as [^/]+ or .*",
      );
    }
    return regex;
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
  const normalized = path.startsWith("/") ? path || "/" : `/${path}`;
  // The home page's Markdown URL is `/index.md` (see `markdownUrl`).
  return normalized === "/index" ? "/" : normalized;
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
 * guide. When the query names no platform, pages that repeat across
 * platforms ("Scrubbing Sensitive Data") collapse too. Returns `undefined`
 * when the page should never collapse.
 */
function duplicateKey(
  page: DocsIndexPage,
  askedWords: ReadonlySet<string>,
  acrossPlatforms: boolean,
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
  const suffix = page.path.slice(prefix.length);
  return acrossPlatforms
    ? `${page.title}\u0000${suffix}`
    : `${platform}\u0000${page.title}\u0000${suffix}`;
}

/**
 * Split the query into words, dropping legacy subcommands and filler. When
 * the query has specific words, its generic words are dropped, and the
 * setup words among them only break ties.
 */
function queryWords(query: string): { words: string[]; weak: string[] } {
  const words = tokenize(query);
  if (words.length > 1 && LEGACY_SUBCOMMANDS.has(words[0] ?? "")) {
    words.shift();
  }
  const kept = words.filter((word) => !FILLER_WORDS.has(word));
  const specific = kept.filter((word) => !GENERIC_WORDS.has(word));
  if (specific.length === 0) {
    return { words: [...new Set(kept)], weak: [] };
  }
  return {
    words: [...new Set(specific)],
    weak: [...new Set(kept.filter((word) => SETUP_WORDS.has(word)))],
  };
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
        `"${pattern}" is not a usable regular expression (${compiled.message}); searched its words instead.`,
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
  const { words, weak } = queryWords(query);
  if (words.length === 0 && regexes.length === 0) {
    warnings.push(
      'The query has no topic words; add one, such as "nextjs tracing".',
    );
    return { results: [], warnings };
  }
  const terms = buildTerms(context, words, warnings);

  const hints = terms.map((term) => platformHint(context, term));
  // Platforms the query names outright (`python`, `nextjs`); a word that
  // only happens to appear under one platform does not name it.
  const namedPlatforms = new Set(
    hints.flatMap((hint) =>
      hint?.inPath ? [`/platforms/${hint.platform}`] : [],
    ),
  );
  /** A platform page that is not of a platform the query names. */
  const otherPlatform = (path: string): boolean =>
    namedPlatforms.size > 0 &&
    path.startsWith("/platforms/") &&
    ![...namedPlatforms].some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    );
  const weakScores = new Map<number, number>();
  for (const term of buildTerms(context, weak, [])) {
    for (const [page, score] of scoreTerm(context, term)) {
      weakScores.set(page, (weakScores.get(page) ?? 0) + score * WEAK_FACTOR);
    }
  }
  const totals = new Map<number, { matched: number; score: number }>();
  if (terms.length === 0) {
    allowed?.forEach((ok, page) => {
      if (ok) {
        totals.set(page, { matched: 0, score: 0 });
      }
    });
  }
  // Pages that match a query word itself; a platform match alone is not one.
  const wordMatches = new Set<number>();
  terms.forEach((term, t) => {
    const scores = scoreTerm(context, term);
    for (const page of scores.keys()) {
      wordMatches.add(page);
    }
    const hint = hints[t];
    if (hint) {
      scorePlatformPages(context, term, hint, hints, scores);
    }
    for (const [page, score] of scores) {
      if (allowed && !allowed[page]) {
        continue;
      }
      const total = totals.get(page) ?? { matched: 0, score: 0 };
      total.matched += 1;
      total.score += score;
      totals.set(page, total);
    }
  });

  const askedWords = new Set(terms.flatMap((term) => term.alternatives));
  const matching = [...totals].filter(
    ([page]) => terms.length === 0 || wordMatches.has(page),
  );
  const ranked = matching.map(([page, total]) => {
    const { path, title } = index.pages[page] as DocsIndexPage;
    return {
      page,
      other: otherPlatform(path),
      matched: total.matched,
      score:
        (total.score +
          (weakScores.get(page) ?? 0) +
          TITLE_COVERAGE_WEIGHT * titleCoverage(title, askedWords)) *
          sectionFactor(path, askedWords) -
        // Shallower pages (overviews, setup) win ties over deep sub-pages.
        path.split("/").length * 0.05,
    };
  });
  // Pages of a platform the query does not name come last: "identify user
  // javascript" must not answer with Android's page.
  ranked.sort(
    (a, b) =>
      Number(a.other) - Number(b.other) ||
      b.matched - a.matched ||
      b.score - a.score ||
      (index.pages[a.page]?.path ?? "").localeCompare(
        index.pages[b.page]?.path ?? "",
      ),
  );

  // Copies across platforms collapse only when no word points to a platform.
  const acrossPlatforms = !hints.some(Boolean);
  const results: DocsSearchResult[] = [];
  const seen = new Map<string, number>();
  let collapsedTitle: string | undefined;
  for (const { page } of ranked) {
    const key =
      regexes.length > 0
        ? undefined
        : duplicateKey(
            index.pages[page] as DocsIndexPage,
            askedWords,
            acrossPlatforms,
          );
    if (key !== undefined) {
      const copies = seen.get(key) ?? 0;
      seen.set(key, copies + 1);
      if (copies > 0) {
        if (acrossPlatforms && seen.size <= options.limit) {
          collapsedTitle ??= index.pages[page]?.title;
        }
        continue;
      }
    }
    if (results.length < options.limit) {
      results.push(toResult(index, page));
    } else if (!acrossPlatforms || collapsedTitle) {
      break;
    }
  }
  if (collapsedTitle) {
    warnings.push(
      `Pages such as "${collapsedTitle}" exist for many platforms and are listed once; add a platform or framework, such as "python" or "nextjs", for its page.`,
    );
  }
  return { results, warnings };
}
