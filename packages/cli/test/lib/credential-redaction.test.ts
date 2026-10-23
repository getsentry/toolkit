import { describe, expect, test } from "vitest";
import { redactCredentialText } from "../../src/lib/credential-redaction.js";
import { ApiError, formatError, getExitCode } from "../../src/lib/errors.js";
import { SentryError } from "../../src/lib/sdk-types.js";

describe("credential redaction", () => {
  test.each([
    ["/ingest/SYNTHETIC_ingest-cap", "/ingest/[REDACTED]"],
    [
      "/stream?cap=SYNTHETIC_read-cap&base64=true",
      "/stream?cap=[REDACTED]&base64=true",
    ],
    [
      "/stream?base64=true&cap=SYNTHETIC_read-cap",
      "/stream?base64=true&cap=[REDACTED]",
    ],
    [
      "/stream?cap=SYNTHETIC_one&cap=SYNTHETIC_two",
      "/stream?cap=[REDACTED]&cap=[REDACTED]",
    ],
    ["/ui/reset?cap=SYNTHETIC_read-cap", "/ui/reset?cap=[REDACTED]"],
    ["/ui/retention?cap=SYNTHETIC_read-cap", "/ui/retention?cap=[REDACTED]"],
    ["/ui/close?cap=SYNTHETIC_read-cap", "/ui/close?cap=[REDACTED]"],
  ])(
    "redacts Local URL capabilities in diagnostics: %s",
    (suffix, safeSuffix) => {
      const path = "/_local/v1/sessions/session-id";
      for (const origin of ["", "http://127.0.0.1:8969", "http://[::1]:8969"]) {
        const message = `POST ${origin}${path}${suffix}`;
        const expected = `POST ${origin}${path}${safeSuffix}`;
        expect(redactCredentialText(message)).toBe(expected);
        expect(
          JSON.parse(redactCredentialText(JSON.stringify({ message }))),
        ).toEqual({ message: expected });
      }
    },
  );

  test("preserves URLs outside the Local capability routes", () => {
    const message =
      "https://example.com/stream?cap=public /_local/v1/sessions/web /_local/v1/sessions/web/ingest/:cap";
    expect(redactCredentialText(message)).toBe(message);
  });

  test.each([
    "sntrys_SYNTHETIC_PAYLOAD\n_SYNTHETIC_SECRET",
    "sntryu_SYNTHETIC_PAYLOAD\r\n_SYNTHETIC_SECRET",
    "legacy_SYNTHETIC_PAYLOAD\n_SYNTHETIC_SECRET",
    "legacy_SYNTHETIC_PAYLOAD\\n_SYNTHETIC_SECRET",
    'legacy_SYNTHETIC_"PAYLOAD\n_SYNTHETIC_SECRET',
    'legacy_SYNTHETIC_" is an invalid header value\n_SYNTHETIC_SECRET',
  ])("redacts invalid Bearer headers through JSON escaping: %j", (token) => {
    let input = `Headers.set: "Bearer ${token}" is an invalid header value.`;
    let expected =
      'Headers.set: "Bearer [REDACTED]" is an invalid header value.';
    for (let level = 0; level <= 3; level++) {
      expect(redactCredentialText(input)).toBe(expected);
      input = JSON.stringify({ error: input });
      expected = JSON.stringify({ error: expected });
    }
  });

  test("handles quotes escaped by JSON serialization", () => {
    const message = JSON.stringify({
      error: 'Headers.set: "Bearer legacy_SYNTHETIC\n_SECRET" is invalid.',
    });
    expect(JSON.parse(redactCredentialText(message))).toEqual({
      error: 'Headers.set: "Bearer [REDACTED]" is invalid.',
    });
  });

  test("preserves nested JSON escaping around quoted Sentry credentials", () => {
    const input = JSON.stringify({
      error: JSON.stringify({ error: 'Rejected "sntryu_SYNTHETIC_SECRET".' }),
    });
    const redacted = redactCredentialText(input);
    expect(JSON.parse(JSON.parse(redacted).error)).toEqual({
      error: 'Rejected "[REDACTED]".',
    });
  });

  test("handles many incomplete runtime diagnostics", () => {
    const diagnostic = 'Headers.set: "Bearer SYNTHETIC_SECRET"; ';
    const expected = 'Headers.set: "Bearer [REDACTED]"; ';
    expect(redactCredentialText(diagnostic.repeat(10_000))).toBe(
      expected.repeat(10_000),
    );
  });

  test.each([
    "\t",
    "\v",
    "\f",
    "\0",
    "\b",
    "\u0085",
    "\u00a0",
    "\u2028",
    "\u2029",
    "\\t",
    "\\b",
    "\\u0000",
    "\\u2028",
  ])("redacts token fragments separated by %j", (separator) => {
    for (const prefix of ["sntryu_", "sntrys_", "Bearer opaque_"]) {
      const input = `Rejected ${prefix}SYNTHETIC_FIRST${separator}SYNTHETIC_TAIL`;
      expect(redactCredentialText(input)).not.toContain("SYNTHETIC");
      expect(
        redactCredentialText(JSON.stringify({ error: input })),
      ).not.toContain("SYNTHETIC");
    }
  });

  test.each([
    [
      "sntrys_SYNTHETIC_PAYLOAD\n_SYNTHETIC_SECRET",
      "Rejected [REDACTED]; try again.",
    ],
    [
      "sntryu_SYNTHETIC_PAYLOAD\\n_SYNTHETIC_SECRET",
      "Rejected [REDACTED]; try again.",
    ],
    [
      "Bearer legacy_SYNTHETIC_PAYLOAD\n_SYNTHETIC_SECRET",
      "Rejected Bearer [REDACTED] try again.",
    ],
  ])("redacts recognizable unquoted credentials: %j", (token, expected) => {
    const redacted = redactCredentialText(`Rejected ${token}; try again.`);
    expect(redacted).toBe(expected);
    expect(redactCredentialText(redacted)).toBe(redacted);
  });

  test.each([
    "opaque:SYNTHETIC_SECRET",
    "opaque!SYNTHETIC_SECRET",
    "opaque@SYNTHETIC_SECRET",
    "opaque;SYNTHETIC_SECRET",
    "opaque,[SYNTHETIC_SECRET]{}",
    "opaque\\SYNTHETIC_SECRET",
    "opaque:SYNTHETIC_PAYLOAD\n  !SYNTHETIC_SECRET",
    "opaque@SYNTHETIC_PAYLOAD\\n  :SYNTHETIC_SECRET",
  ])("redacts punctuation in an unquoted Bearer value: %j", (token) => {
    let input = `Authorization: Bearer ${token}`;
    let expected = "Authorization: Bearer [REDACTED]";
    for (let level = 0; level <= 2; level++) {
      const redacted = redactCredentialText(input);
      expect(redacted).toBe(expected);
      expect(redactCredentialText(redacted)).toBe(expected);
      input = JSON.stringify({ error: input, status: 401 });
      expected = JSON.stringify({ error: expected, status: 401 });
    }
  });

  test("redacts a quoted header truncated before its closing quote", () => {
    expect(
      redactCredentialText('Headers.set: "Bearer legacy_PAYLOAD\n_SECRET...'),
    ).toBe('Headers.set: "Bearer [REDACTED]"');
  });

  test("leaves ordinary diagnostic text intact", () => {
    const text = 'GET /api/0/projects/ failed: "Not found" (HTTP 404).';
    expect(redactCredentialText(text)).toBe(text);
  });
});

describe("error output boundaries", () => {
  const token = "sntrys_SYNTHETIC_PAYLOAD\n_SYNTHETIC_SECRET";
  const message = `Headers.set: "Bearer ${token}" is an invalid header value.`;

  test("formats errors safely without changing the error or exit code", () => {
    const error = new ApiError(message, 500, `Details: ${token}`);
    expect(formatError(error)).not.toContain("SYNTHETIC");
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe(message);
    expect(error.status).toBe(500);
    expect(getExitCode(error)).toBe(30);
  });

  test("formats non-Error thrown objects safely", () => {
    const formatted = formatError({ error: message });
    expect(JSON.parse(formatted)).toEqual({
      error: 'Headers.set: "Bearer [REDACTED]" is an invalid header value.',
    });
  });

  test("SDK error message, stack, stderr, and JSON are safe", () => {
    const error = new SentryError(message, 12, `${message}\n`);
    expect(error.name).toBe("SentryError");
    expect(error.exitCode).toBe(12);
    expect(error.message).not.toContain("SYNTHETIC");
    expect(error.stack).not.toContain("SYNTHETIC");
    expect(error.stderr).not.toContain("SYNTHETIC");
    expect(
      JSON.stringify({
        message: error.message,
        ...Object.fromEntries(Object.entries(error)),
      }),
    ).not.toContain("SYNTHETIC");
  });
});
