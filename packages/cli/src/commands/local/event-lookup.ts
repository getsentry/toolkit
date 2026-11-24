/**
 * Event ID lookup for `local event view`: a full event ID, a bare replay ID,
 * or a unique prefix of one, the way `git` accepts a short commit hash.
 */

/** Only nonempty string IDs from event-bearing envelope fields are lookup keys. */
export function eventIdFrom(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const id = (value as Record<string, unknown>)["event_id"];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * The event ID `local event list` and `view` use for an envelope: its header
 * `event_id`, else that of its first event or transaction item, from the item
 * header or its payload. `payload` is called only when that is needed.
 */
export function envelopeLookupId(
  header: unknown,
  items: readonly { header: unknown; payload: () => unknown }[],
): string | undefined {
  const headerId = eventIdFrom(header);
  if (headerId) return headerId;
  for (const item of items) {
    const type = eventItemType(item.header);
    if (type !== "event" && type !== "transaction") continue;
    const id = eventIdFrom(item.header) ?? eventIdFrom(item.payload());
    if (id) return id;
  }
  return undefined;
}

function eventItemType(itemHeader: unknown): unknown {
  return typeof itemHeader === "object" && itemHeader !== null
    ? (itemHeader as Record<string, unknown>)["type"]
    : undefined;
}

/** Shortest event ID prefix that `local event view` matches. */
export const EVENT_ID_PREFIX_MIN_LENGTH = 8;

/** `code` of the control plane's 409 body for an event ID prefix that matches several events. */
export const AMBIGUOUS_EVENT_CODE = "ambiguous_event";

/** A reference made of hex digits, with an optional `:<segment>` suffix. */
const HEX_REFERENCE = /^[0-9a-f]+(?::\d+)?$/i;

/** What follows the replay ID in a replay segment's lookup key. */
const SEGMENT_SUFFIX = /^:(\d+)$/;

/**
 * The case-free form IDs compare by: a hex reference and the stored IDs it is
 * checked against, and every stored ID when picking prefixes, since a
 * hex-looking prefix of a non-hex ID is also looked up without case.
 */
function foldCase(value: string): string {
  return value.toLowerCase();
}

/**
 * Distinct event IDs that `reference` selects, in this order: the ID equal to
 * it; for a bare replay ID, whose every match is `<reference>:<segment>`, the
 * lowest segment; else every ID it is a prefix of. Hex references match stored
 * IDs in any case. A reference shorter than {@link EVENT_ID_PREFIX_MIN_LENGTH}
 * matches no prefix, so short non-hex lookup keys keep working without
 * matching half the session.
 */
export function matchEventIds(
  eventIds: readonly string[],
  reference: string,
): string[] {
  if (eventIds.includes(reference)) {
    return [reference];
  }
  const key = HEX_REFERENCE.test(reference)
    ? foldCase
    : (value: string) => value;
  const wanted = key(reference);
  const exact = eventIds.filter((id) => key(id) === wanted);
  if (exact.length > 0) {
    return [...new Set(exact)];
  }
  const startingWith = eventIds.filter((id) => key(id).startsWith(wanted));
  const segment = firstReplaySegment(startingWith, wanted.length);
  if (segment !== undefined) {
    return [segment];
  }
  if (wanted.length < EVENT_ID_PREFIX_MIN_LENGTH) {
    return [];
  }
  return [...new Set(startingWith)];
}

/**
 * The lowest-numbered segment key among `ids`, which all start with a
 * `replayIdLength`-character replay ID, or undefined when there are none or
 * one of them is not a segment key of that replay.
 */
function firstReplaySegment(
  ids: readonly string[],
  replayIdLength: number,
): string | undefined {
  let first: { id: string; segment: number } | undefined;
  for (const id of ids) {
    const match = SEGMENT_SUFFIX.exec(id.slice(replayIdLength));
    if (!match) {
      return;
    }
    const segment = Number(match[1]);
    if (!first || segment < first.segment) {
      first = { id, segment };
    }
  }
  return first?.id;
}

/** Compares UTF-16 code units, like the default `.sort()`; not `localeCompare`, which orders by locale. */
function compare(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function sharedPrefixLength(left: string, right: string | undefined): number {
  if (right === undefined) {
    return 0;
  }
  let length = 0;
  while (
    length < left.length &&
    length < right.length &&
    left[length] === right[length]
  ) {
    length += 1;
  }
  return length;
}

/**
 * Shortest prefix of each event ID, at least
 * {@link EVENT_ID_PREFIX_MIN_LENGTH} characters, that no other listed ID
 * starts with in any case, so each one shown by `local event list` opens with
 * `local event view`. An ID that is a prefix of another stays whole.
 *
 * Prefixes compare like hex references in {@link matchEventIds}, without
 * case. That also covers non-hex IDs, which only match in their own case, so
 * at worst they show a few more characters. IDs that differ only in case share
 * every case-free prefix, so they show in full and open by the exact match.
 */
export function uniqueEventIdPrefixes(
  eventIds: readonly string[],
): Map<string, string> {
  const sorted = [...new Set(eventIds)]
    .map((id) => ({ id, key: foldCase(id) }))
    .sort((left, right) => compare(left.key, right.key));
  return new Map(
    sorted.map(({ id, key }, index) => {
      const shared = Math.max(
        sharedPrefixLength(key, sorted[index - 1]?.key),
        sharedPrefixLength(key, sorted[index + 1]?.key),
      );
      return [
        id,
        id.slice(0, Math.max(EVENT_ID_PREFIX_MIN_LENGTH, shared + 1)),
      ];
    }),
  );
}
