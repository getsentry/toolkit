/**
 * Read the few values the Apple Snapshots wizard needs from Xcode's XML
 * files: the `BlueprintName` attributes under a scheme's `<TestAction>`, and
 * the `<key>` texts of `xcschememanagement.plist`.
 *
 * This is a scanner for those shapes, not a general XML parser: it ignores
 * comments, CDATA sections and processing instructions, and expects the
 * element it extracts not to nest inside itself (true for `TestAction`).
 */

/** Matches comments, CDATA sections, and `<?…?>` / `<!…>` declarations. */
const IGNORED_MARKUP_RE =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[?!][^>]*>/g;

/** The five predefined XML entities plus numeric character references. */
const ENTITY_RE = /&(?:#(\d+)|#x([\da-f]+)|(amp|lt|gt|quot|apos));/gi;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Escape `value` for use inside a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Decode XML entity and character references in `value`. */
export function decodeXmlEntities(value: string): string {
  return value.replace(
    ENTITY_RE,
    (match, decimal?: string, hex?: string, named?: string) => {
      if (decimal) {
        return String.fromCodePoint(Number.parseInt(decimal, 10));
      }
      if (hex) {
        return String.fromCodePoint(Number.parseInt(hex, 16));
      }
      return NAMED_ENTITIES[named?.toLowerCase() ?? ""] ?? match;
    },
  );
}

/**
 * `xml` without comments, CDATA sections and declarations. Strips until
 * nothing changes, so removing one span can't leave another behind, such as
 * the `<!-- … -->` that `<<!-- x -->!-- … -->` turns into.
 */
function stripIgnoredMarkup(xml: string): string {
  let previous: string;
  let stripped = xml;
  do {
    previous = stripped;
    stripped = previous.replace(IGNORED_MARKUP_RE, "");
  } while (stripped !== previous);
  return stripped;
}

/**
 * The markup between the first `<name …>` and its `</name>`, or `""` for a
 * self-closing `<name/>`. `undefined` when there is no such element.
 */
export function getElementContent(
  xml: string,
  name: string,
): string | undefined {
  const tag = escapeRegExp(name);
  const match = new RegExp(
    `<${tag}(?:\\s[^>]*?)?(?:/>|>([\\s\\S]*?)</${tag}\\s*>)`,
  ).exec(stripIgnoredMarkup(xml));
  if (!match) {
    return undefined;
  }
  return match[1] ?? "";
}

/** Every value of the attribute `attribute`, on any element in `xml`. */
export function getAttributeValues(xml: string, attribute: string): string[] {
  const re = new RegExp(
    `\\s${escapeRegExp(attribute)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    "g",
  );
  const values: string[] = [];
  for (const tag of stripIgnoredMarkup(xml).match(/<[^>]+>/g) ?? []) {
    for (const match of tag.matchAll(re)) {
      values.push(decodeXmlEntities(match[1] ?? match[2] ?? ""));
    }
  }
  return values;
}

/** The text of every `<name>text</name>` element in `xml`. */
export function getElementTexts(xml: string, name: string): string[] {
  const tag = escapeRegExp(name);
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}\\s*>`, "g");
  return [...stripIgnoredMarkup(xml).matchAll(re)].map((match) =>
    decodeXmlEntities(match[1] ?? ""),
  );
}
