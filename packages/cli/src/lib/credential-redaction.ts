/**
 * Stateless credential redaction for CLI diagnostics and telemetry.
 * Kept free of SDK imports for CLI startup and the completion fast path.
 * Successful API responses are not passed through this redactor.
 */

const INVALID_BEARER_HEADER_START =
  /(\bHeaders\.(?:set|append):[ \t]*)(\\*["'])Bearer[ \t]+/gi;
const INVALID_HEADER_END = /(?<!\\)(\\*["']) is an invalid header value/gi;
// Header validation errors quote the entire value, including invalid newlines.
// The end-of-string alternative also covers messages truncated by the SDK.
const QUOTED_CREDENTIAL =
  /(?<!\\)(\\*["'])(Bearer[ \t]+|sntry[su]_)[\s\S]*?(?:\1|$)/gi;
/** Control characters can also appear escaped in serialized diagnostics. */
const ESCAPED_CONTROL = /\\+(?:[nrtbfv]|u00[01][\da-f]|u007f|u202[89])/.source;
const BEARER_PART = String.raw`(?:${ESCAPED_CONTROL}[ \t]*|\\+[^"'\s\\]|[^\s"'\\])`;
// An explicit Bearer context can contain opaque tokens with punctuation.
// Quotes (including JSON-escaped quotes) delimit the diagnostic string.
const BEARER_CREDENTIAL = new RegExp(
  String.raw`\bBearer[ \t]+${BEARER_PART}+(?:(?:\r\n|(?! )[\s\x00-\x1f\x7f-\x9f])[ \t]*${BEARER_PART}+)*`,
  "gi",
);
const SENTRY_CREDENTIAL = new RegExp(
  String.raw`\bsntry[su]_[A-Za-z0-9._~+/=-]+(?:(?:\r\n|(?! )[\s\x00-\x1f\x7f-\x9f]|${ESCAPED_CONTROL})[ \t]*[A-Za-z0-9._~+/=-]+)*`,
  "gi",
);

/**
 * Use the runtime's final delimiter because an invalid token can contain quotes.
 * This may also hide text between concatenated diagnostics with the same quote:
 * the runtime does not distinguish a delimiter inside a token from its end.
 * Index suffixes once so repeated header prefixes cannot cause quadratic scans.
 */
function redactInvalidBearerHeaders(text: string): string {
  const lastEnds = new Map<string, number>();
  for (const match of text.matchAll(INVALID_HEADER_END)) {
    const quote = match[1];
    if (quote) {
      lastEnds.set(quote, match.index);
    }
  }
  if (lastEnds.size === 0) {
    return text;
  }

  const parts: string[] = [];
  let cursor = 0;
  for (const match of text.matchAll(INVALID_BEARER_HEADER_START)) {
    if (match.index < cursor) {
      continue;
    }
    const [, prefix, quote] = match;
    if (!(prefix && quote)) {
      continue;
    }
    const end = lastEnds.get(quote);
    if (end === undefined || end < match.index + match[0].length) {
      continue;
    }
    parts.push(
      text.slice(cursor, match.index),
      `${prefix}${quote}Bearer [REDACTED]${quote}`,
    );
    cursor = end + quote.length;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

/** Remove recognizable credentials from diagnostics without retaining secrets. */
export function redactCredentialText(text: string): string {
  return redactInvalidBearerHeaders(text)
    .replace(QUOTED_CREDENTIAL, (_match, quote: string, prefix: string) =>
      prefix.toLowerCase().startsWith("bearer")
        ? `${quote}Bearer [REDACTED]${quote}`
        : `${quote}[REDACTED]${quote}`,
    )
    .replace(BEARER_CREDENTIAL, "Bearer [REDACTED]")
    .replace(SENTRY_CREDENTIAL, "[REDACTED]");
}
