/**
 * Free-text search over the command catalog for `search_sentry`.
 *
 * Ranks by where query words appear: the command path counts most, then its
 * brief, then its flag names and example descriptions. Words are compared
 * after dropping a plural `s`, so "issues" finds `issue list`.
 */

import type { CommandCatalog, CommandCatalogEntry } from "../command-catalog";
import { commandName } from "./commands";

const PATH_SEGMENT_SCORE = 10;
const PATH_PARTIAL_SCORE = 5;
const BRIEF_SCORE = 3;
const DETAIL_SCORE = 1;
/** Bonus when the whole query appears in the name or brief. */
const PHRASE_SCORE = 8;
/** Bonus per word when every query word matched somewhere. */
const ALL_WORDS_SCORE = 2;

/** Lowercase words, without a plural `s` (`issues` → `issue`). */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((word) =>
      word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word,
    );
}

type Indexed = {
  entry: CommandCatalogEntry;
  name: string;
  segments: string[];
  brief: Set<string>;
  details: Set<string>;
};

/** Words of the example descriptions (`# List organizations`). */
function exampleWords(entry: CommandCatalogEntry): string[] {
  return entry.examples.flatMap((example) =>
    words(example.split("\n")[0]?.replace(/^#\s*/, "") ?? ""),
  );
}

function index(entry: CommandCatalogEntry): Indexed {
  const name = commandName(entry);
  const flags = Object.keys(
    entry.parameters.properties?.flags?.properties ?? {},
  );
  return {
    entry,
    name,
    segments: words(name),
    brief: new Set(words(entry.brief)),
    details: new Set([...flags.flatMap(words), ...exampleWords(entry)]),
  };
}

/** `org` and `organization`, `dash` and `dashboard`; not one- or two-letter words. */
function isPartialMatch(segment: string, word: string): boolean {
  return (
    Math.min(segment.length, word.length) >= 3 &&
    (segment.startsWith(word) || word.startsWith(segment))
  );
}

function score(item: Indexed, query: string, queryWords: string[]): number {
  let total = 0;
  let matched = 0;
  for (const word of queryWords) {
    let wordScore = 0;
    if (item.segments.includes(word)) {
      wordScore += PATH_SEGMENT_SCORE;
    } else if (item.segments.some((segment) => isPartialMatch(segment, word))) {
      wordScore += PATH_PARTIAL_SCORE;
    }
    if (item.brief.has(word)) {
      wordScore += BRIEF_SCORE;
    }
    if (item.details.has(word)) {
      wordScore += DETAIL_SCORE;
    }
    if (wordScore > 0) {
      matched++;
    }
    total += wordScore;
  }
  const phrase = query.trim().toLowerCase();
  if (
    phrase.includes(" ") &&
    (item.name.includes(phrase) ||
      item.entry.brief.toLowerCase().includes(phrase))
  ) {
    total += PHRASE_SCORE;
  }
  if (queryWords.length > 1 && matched === queryWords.length) {
    total += ALL_WORDS_SCORE * matched;
  }
  return total;
}

/** The catalog's commands that best match `query`, best first. */
export function searchCommands(
  catalog: CommandCatalog,
  query: string,
  limit: number,
): CommandCatalogEntry[] {
  const queryWords = [...new Set(words(query))];
  if (queryWords.length === 0) {
    return [];
  }
  return catalog.commands
    .map(index)
    .map((item) => ({ item, score: score(item, query, queryWords) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
    .slice(0, limit)
    .map(({ item }) => item.entry);
}
