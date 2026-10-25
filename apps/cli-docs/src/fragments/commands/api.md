

## Endpoints

Endpoints are relative to `/api/0/` — the prefix is added automatically. Absolute HTTP(S) Sentry URLs also work; their origin is validated against your authenticated host.

If a successful GET response is interrupted while downloading, the CLI retries
within its existing limit of three attempts. This also applies to complete API
responses read by other commands. The request timeout covers these response
bodies; streaming responses such as SSE are excluded.

## Dataset Names

When querying the Events API (`/events/` endpoint), valid dataset values are: `spans`, `logs`, `errors`, `tracemetrics`, `profile_functions`, and `uptime_results`.

## Pagination

Each invocation fetches one page. With `--json`, successful textual responses
include `pagination.nextCursor` and/or `pagination.prevCursor` when the server's
`Link` header advertises a usable continuation. `--fields` filters only the
response body and preserves this metadata.

Repeat the same GET request with `--cursor <token>` to continue, keeping its
filters, ordering, page size, and time range. The token is opaque: `next` and
`prev` do not refer to saved pages. `--cursor` replaces existing cursor parameters
from both the endpoint URL and request fields; all other parameters are retained.
It is only supported for GET requests, including `--dry-run` previews.

When no usable cursor is advertised, `pagination` is omitted. This does not prove
that the underlying dataset was fully scanned or unsampled. The command does not
automatically follow pages.

## Binary responses

Endpoints that return binary data — image attachments, minidumps, debug files — are streamed to stdout as raw bytes, so you can redirect them straight to a file.

When the response is a PNG or JPEG image **and** you're on a graphics-capable terminal, the image is rendered inline instead of dumping raw bytes into your session. Terminals that speak the newer kitty graphics protocol (kitty, WezTerm, Ghostty, recent Konsole) are used in preference to sixel, which remains the fallback for older terminals. Redirecting or piping stdout always keeps the raw bytes. Set `SENTRY_NO_GRAPHICS=1` (or run `sentry cli defaults graphics off`) to disable inline rendering; `SENTRY_NO_SIXEL` is still honored as a deprecated alias.

For full API documentation, see the [Sentry API Reference](https://docs.sentry.io/api/).
