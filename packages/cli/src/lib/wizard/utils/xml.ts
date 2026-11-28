/**
 * A minimal XML reader for the wizards.
 *
 * It parses elements and attributes into a tree and skips everything else:
 * text, comments, CDATA, processing instructions, and the doctype. It never
 * writes XML; wizards edit files as strings to keep their formatting. The
 * Android wizard uses it to read `AndroidManifest.xml`.
 */

/** One XML element: its tag name, attributes, and child elements. */
export type XmlElement = {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
};

const NAME_PATTERN = /[A-Za-z_:][\w.:-]*/y;
const ATTRIBUTE_PATTERN =
  /\s*([A-Za-z_:][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Replace the predefined and numeric character references in `value`. */
export function decodeXmlEntities(value: string): string {
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (match, entity: string) => {
      if (entity.startsWith("#x") || entity.startsWith("#X")) {
        return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
      }
      if (entity.startsWith("#")) {
        return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
      }
      return NAMED_ENTITIES[entity] ?? match;
    },
  );
}

/** Index just past `terminator` from `from`, or throw when it never comes. */
function skipPast(xml: string, from: number, terminator: string): number {
  const end = xml.indexOf(terminator, from);
  if (end === -1) {
    throw new Error(`Malformed XML: missing "${terminator}".`);
  }
  return end + terminator.length;
}

/**
 * Parse `xml` and return its root element.
 *
 * @throws {Error} When the document has no root element, or a tag is
 *   malformed or left unclosed
 */
export function parseXml(xml: string): XmlElement {
  const root: XmlElement = { name: "", attributes: {}, children: [] };
  const stack: XmlElement[] = [root];
  let index = 0;

  while (index < xml.length) {
    const tagStart = xml.indexOf("<", index);
    if (tagStart === -1) {
      break;
    }

    if (xml.startsWith("<!--", tagStart)) {
      index = skipPast(xml, tagStart + 4, "-->");
      continue;
    }
    if (xml.startsWith("<![CDATA[", tagStart)) {
      index = skipPast(xml, tagStart + 9, "]]>");
      continue;
    }
    if (xml.startsWith("<?", tagStart)) {
      index = skipPast(xml, tagStart + 2, "?>");
      continue;
    }
    if (xml.startsWith("<!", tagStart)) {
      // A doctype. Internal subsets ("[...]") are not supported, and
      // manifests don't use them.
      index = skipPast(xml, tagStart + 2, ">");
      continue;
    }

    const parent = stack.at(-1);
    if (!parent) {
      throw new Error("Malformed XML: unbalanced tags.");
    }

    if (xml.startsWith("</", tagStart)) {
      NAME_PATTERN.lastIndex = tagStart + 2;
      const name = NAME_PATTERN.exec(xml)?.[0];
      if (name !== parent.name || stack.length === 1) {
        throw new Error(`Malformed XML: unexpected closing tag </${name}>.`);
      }
      stack.pop();
      index = skipPast(xml, NAME_PATTERN.lastIndex, ">");
      continue;
    }

    NAME_PATTERN.lastIndex = tagStart + 1;
    const name = NAME_PATTERN.exec(xml)?.[0];
    if (!name) {
      throw new Error("Malformed XML: tag without a name.");
    }
    const element: XmlElement = { name, attributes: {}, children: [] };
    let cursor = NAME_PATTERN.lastIndex;

    for (;;) {
      ATTRIBUTE_PATTERN.lastIndex = cursor;
      const attribute = ATTRIBUTE_PATTERN.exec(xml);
      if (!attribute) {
        break;
      }
      const [, attributeName = "", doubleQuoted, singleQuoted] = attribute;
      element.attributes[attributeName] = decodeXmlEntities(
        doubleQuoted ?? singleQuoted ?? "",
      );
      cursor = ATTRIBUTE_PATTERN.lastIndex;
    }

    const tagEnd = /\s*(\/?)>/y;
    tagEnd.lastIndex = cursor;
    const end = tagEnd.exec(xml);
    if (!end) {
      throw new Error(`Malformed XML: invalid <${name}> tag.`);
    }
    parent.children.push(element);
    if (!end[1]) {
      stack.push(element);
    }
    index = tagEnd.lastIndex;
  }

  if (stack.length > 1) {
    throw new Error(`Malformed XML: <${stack.at(-1)?.name}> is not closed.`);
  }
  const [documentElement] = root.children;
  if (!documentElement || root.children.length > 1) {
    throw new Error("Malformed XML: expected exactly one root element.");
  }
  return documentElement;
}

/** The direct children of `element` named `name`. */
export function childElements(
  element: XmlElement | undefined,
  name: string,
): XmlElement[] {
  return element?.children.filter((child) => child.name === name) ?? [];
}
