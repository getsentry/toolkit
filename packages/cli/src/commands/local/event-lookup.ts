/**
 * Event ID lookup for `local event view`: a full event ID, or a unique prefix
 * of one, the way `git` accepts a short commit hash.
 */

/** Shortest event ID prefix that `local event view` matches. */
export const EVENT_ID_PREFIX_MIN_LENGTH = 8;

/** `code` of the control plane's 409 body for an event ID prefix that matches several events. */
export const AMBIGUOUS_EVENT_CODE = "ambiguous_event";

/**
 * Distinct event IDs that `reference` selects: the ID itself when one equals
 * it, else every ID it is a prefix of. A reference shorter than
 * {@link EVENT_ID_PREFIX_MIN_LENGTH} matches only exactly, so short
 * non-hex lookup keys keep working without matching half the session.
 */
export function matchEventIds(
  eventIds: readonly string[],
  reference: string,
): string[] {
  if (eventIds.includes(reference)) {
    return [reference];
  }
  if (reference.length < EVENT_ID_PREFIX_MIN_LENGTH) {
    return [];
  }
  return [...new Set(eventIds.filter((id) => id.startsWith(reference)))];
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
