import { isPlainObject } from "./type-guards";

export const REDACTED_VALUE = "[REDACTED]";

// Names are compared lowercased with `-`, `_`, and spaces removed, so
// `x-api-key`, `api_key`, and `apiKey` all match. These are the credential
// names that the name parts below don't cover.
const SENSITIVE_HEADER_NAMES = new Set([
  "cookie",
  "setcookie",
  "xcsrftoken",
  "xsentryauth",
]);

const SENSITIVE_NAME_PARTS = [
  "authorization",
  "apikey",
  "accesskey",
  "accesstoken",
  "authtoken",
  "secret",
  "password",
];

// One `Name: value` line of a raw HTTP header block, such as Node's
// serialized `ClientRequest._header`.
const HEADER_LINE_PATTERN = /^([!#$%&'*+.^`|~\w-]+)([ \t]*:[ \t]*)(.*)$/gm;

/** Whether a header or field name usually holds a credential. */
export function isSensitiveHeaderName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[\s_-]/g, "");
  if (SENSITIVE_HEADER_NAMES.has(normalized)) {
    return true;
  }
  return SENSITIVE_NAME_PARTS.some((part) => normalized.includes(part));
}

function redactHeaderLines(text: string): string {
  return text.replace(HEADER_LINE_PATTERN, (line, name, separator, value) =>
    value && isSensitiveHeaderName(name)
      ? `${name}${separator}${REDACTED_VALUE}`
      : line,
  );
}

/**
 * Copy event data with credential values replaced.
 *
 * SDKs attach serialized HTTP clients (for example Axios errors) to event
 * extras. Their header objects and raw header strings can carry credentials
 * that Sentry's server-side scrubbing missed. Redact values under sensitive
 * keys, values that follow a sensitive name in `[name, value]` and
 * `rawHeaders` lists, and sensitive lines in raw header text.
 */
export function redactSensitiveValues<T>(value: T): T {
  return redactValue(value) as T;
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactHeaderLines(value);
  }
  if (Array.isArray(value)) {
    // `[name, value]` pairs and Node's flat `rawHeaders` lists.
    if (
      value.length % 2 === 0 &&
      value.every((entry) => typeof entry === "string")
    ) {
      return value.map((entry, index) =>
        index % 2 === 1 && isSensitiveHeaderName(value[index - 1])
          ? REDACTED_VALUE
          : redactHeaderLines(entry),
      );
    }
    return value.map(redactValue);
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        isSensitiveHeaderName(key) ? redactLeaves(entry) : redactValue(entry),
      ]),
    );
  }
  return value;
}

// Everything under a sensitive key is a credential, including
// `set-cookie: ["..."]` lists and nested auth objects.
function redactLeaves(value: unknown): unknown {
  if (typeof value === "string" || typeof value === "number") {
    return REDACTED_VALUE;
  }
  if (Array.isArray(value)) {
    return value.map(redactLeaves);
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactLeaves(entry)]),
    );
  }
  return value;
}
