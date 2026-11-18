/**
 * Event ID lookup for `local event view`: a full event ID, a bare replay ID,
 * or a unique prefix of one, the way `git` accepts a short commit hash.
 */

/** Shortest event ID prefix that `local event view` matches. */
export const EVENT_ID_PREFIX_MIN_LENGTH = 8;

/** `code` of the control plane's 409 body for an event ID prefix that matches several events. */
export const AMBIGUOUS_EVENT_CODE = "ambiguous_event";

/** A reference made of hex digits, with an optional `:<segment>` suffix. */
const HEX_REFERENCE = /^[0-9a-f]+(?::\d+)?$/i;

/** What follows the replay ID in a replay segment's lookup key. */
const SEGMENT_SUFFIX = /^:(\d+)$/;

/**
 * Distinct event IDs that `reference` selects, in this order: the ID equal to
 * it; for a bare replay ID, whose every match is `<reference>:<segment>`, the
 * lowest segment; else every ID it is a prefix of. Hex references match in any
 * case. A reference shorter than {@link EVENT_ID_PREFIX_MIN_LENGTH} matches no
 * prefix, so short non-hex lookup keys keep working without matching half the
 * session.
 */
export function matchEventIds(
  eventIds: readonly string[],
  reference: string,
): string[] {
  if (eventIds.includes(reference)) {
    return [reference];
  }
  const normalized = HEX_REFERENCE.test(reference)
    ? reference.toLowerCase()
    : reference;
  if (eventIds.includes(normalized)) {
    return [normalized];
  }
  const segment = firstReplaySegment(eventIds, normalized);
  if (segment !== undefined) {
    return [segment];
  }
  if (normalized.length < EVENT_ID_PREFIX_MIN_LENGTH) {
    return [];
  }
  return [...new Set(eventIds.filter((id) => id.startsWith(normalized)))];
}

/**
 * The lowest-numbered segment key of `replayId`, or undefined when no ID
 * starts with it or one that does is not one of its segment keys.
 */
function firstReplaySegment(
  eventIds: readonly string[],
  replayId: string,
): string | undefined {
  let first: { id: string; segment: number } | undefined;
  for (const id of eventIds) {
    if (!id.startsWith(replayId)) {
      continue;
    }
    const match = SEGMENT_SUFFIX.exec(id.slice(replayId.length));
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
 * starts with, so each one shown by `local event list` opens with
 * `local event view`. An ID that is a prefix of another stays whole.
 */
export function uniqueEventIdPrefixes(
  eventIds: readonly string[],
): Map<string, string> {
  const sorted = [...new Set(eventIds)].sort();
  return new Map(
    sorted.map((id, index) => {
      const shared = Math.max(
        sharedPrefixLength(id, sorted[index - 1]),
        sharedPrefixLength(id, sorted[index + 1]),
      );
      return [
        id,
        id.slice(0, Math.max(EVENT_ID_PREFIX_MIN_LENGTH, shared + 1)),
      ];
    }),
  );
}
