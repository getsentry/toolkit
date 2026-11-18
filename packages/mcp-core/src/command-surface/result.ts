/**
 * Shapes a command's output into an execute tool result: the next cursor
 * lifted out of list envelopes, and the whole result capped in size.
 */

/**
 * Largest result text, in characters (about 12,500 tokens). Claude Code's
 * default MCP output limit is 25,000 tokens; staying well under it leaves
 * room for several results in one turn.
 */
const MAX_RESULT_CHARS = 50_000;

type Envelope = Record<string, unknown> & {
  data?: unknown;
  nextCursor?: unknown;
};

type Payload = {
  command: string;
  result: unknown;
  nextCursor?: string;
};

function isEnvelope(value: unknown): value is Envelope {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Lift a non-empty `nextCursor` out of a list envelope (`{ data, hasMore, nextCursor }`). */
function withCursor(command: string, output: unknown): Payload {
  if (
    isEnvelope(output) &&
    typeof output.nextCursor === "string" &&
    output.nextCursor
  ) {
    const { nextCursor, ...rest } = output;
    return { command, nextCursor, result: rest };
  }
  return { command, result: output ?? null };
}

/** The list a result can be cut down by, and how to put a shorter one back. */
function listOf(
  result: unknown,
): { items: unknown[]; rebuild: (items: unknown[]) => unknown } | undefined {
  if (Array.isArray(result)) {
    return { items: result, rebuild: (items) => items };
  }
  if (isEnvelope(result) && Array.isArray(result.data)) {
    return {
      items: result.data,
      rebuild: (items) => ({ ...result, data: items }),
    };
  }
  return;
}

/**
 * The longest prefix of a list result that fits in `maxChars`, found by
 * binary search over the serialized size. `nextCursor` is dropped: it points
 * past the whole page, so following it would skip the dropped items.
 */
function truncateList(payload: Payload, maxChars: number): string | undefined {
  const list = listOf(payload.result);
  if (!list) {
    return;
  }
  const { nextCursor, ...rest } = payload;
  const total = list.items.length;
  const render = (count: number) =>
    JSON.stringify({
      ...rest,
      result: list.rebuild(list.items.slice(0, count)),
      truncated: {
        returned: count,
        total,
        hint: nextCursor
          ? "The result was too large, so the items after these were dropped, and no nextCursor is returned because it would skip them. Ask again with a lower limit, or fewer fields (fields), to page through them."
          : "The result was too large, so the items after these were dropped. Ask for fewer items (limit) or fewer fields (fields).",
      },
    });
  let low = 0;
  let high = total - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (render(middle).length <= maxChars) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  const text = render(low);
  return text.length <= maxChars ? text : undefined;
}

/**
 * A result that is not a list, cut to fit in `maxChars`: `result` holds the
 * start of its JSON text as a string, so the tool still returns valid JSON.
 */
function truncateText(
  payload: Payload,
  text: string,
  maxChars: number,
): string {
  // The cursor would skip what was cut, as in `truncateList`.
  const { nextCursor: _skipped, ...rest } = payload;
  const render = (length: number) =>
    JSON.stringify({
      ...rest,
      result: text.slice(0, length),
      truncated: {
        characters: text.length,
        hint: "The result was too large, so result holds only the start of its JSON text. Select fewer fields with the fields flag.",
      },
    });
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (render(middle).length <= maxChars) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return render(low);
}

/**
 * The text an execute tool returns for `output`: JSON with the command, the
 * result, and `nextCursor` for paginated commands. A result over `maxChars`
 * keeps as many list items as fit, or keeps the start of its JSON text.
 */
export function formatCommandResult(
  command: string,
  output: unknown,
  maxChars = MAX_RESULT_CHARS,
): string {
  if (output instanceof Uint8Array) {
    return JSON.stringify({
      command,
      result: null,
      error: `The command returned ${output.byteLength} bytes of binary output, which this tool cannot return.`,
    });
  }
  const payload = withCursor(command, output);
  const text = JSON.stringify(payload);
  if (text.length <= maxChars) {
    return text;
  }
  return (
    truncateList(payload, maxChars) ??
    truncateText(payload, JSON.stringify(payload.result), maxChars)
  );
}
