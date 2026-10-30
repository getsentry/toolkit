

## Endpoints

Endpoints are relative to `/api/0/` — the prefix is added automatically. Absolute HTTP(S) Sentry URLs also work; their origin is validated against your authenticated host.

If a successful GET response is interrupted while downloading, the CLI retries
within its existing limit of three attempts. This also applies to complete API
responses read by other commands. The request timeout covers these response
bodies; streaming responses such as SSE are excluded.

## Dataset Names

When querying the Events API (`/events/` endpoint), valid dataset values are: `spans`, `logs`, `errors`, `tracemetrics`, `profile_functions`, and `uptime_results`.

## Pagination

Each invocation fetches one server page. Repeat the same GET endpoint and filters
with `--cursor next` (`-c next`) to continue, `--cursor prev` to revisit a page,
or `--cursor first` to start again. The shared history expires after five minutes
and is scoped to the request and authenticated identity. Keep the same query
parameters and headers when navigating. The endpoint remains required.

Raw server cursors and custom cursors from the CLI's shared paginator are also
accepted. Custom cursors preserve the page size and skip rows already returned,
including when navigating back to a bookmarked page. A cursor's encoded page
size takes precedence over `per_page`. Mid-page bookmarks support array bodies
and responses with a `data` array, such as the Events API; envelope metadata is
preserved. Other response bodies remain unchanged for ordinary cursors.

With `--json`, `pagination.nextCursor` is the CLI continuation and can retain a
custom bookmark; pass it back through `--cursor` to resume exactly.
`pagination.prevCursor` comes from the server, while `pagination.hasPrev`
indicates a previously visited page in local history. `--fields` filters only
the body and preserves this metadata.
The pagination object is omitted when no continuation or local previous page is
available. Its absence does not prove a complete or unsampled dataset.

`--cursor` replaces cursor parameters from the endpoint and request fields. It is
only supported for GET requests. `--dry-run` previews the resolved request;
dry-runs and failed requests do not advance the saved history.

## Binary responses

Endpoints that return binary data — image attachments, minidumps, debug files — are streamed to stdout as raw bytes, so you can redirect them straight to a file.

When the response is a PNG or JPEG image **and** you're on a graphics-capable terminal, the image is rendered inline instead of dumping raw bytes into your session. Terminals that speak the newer kitty graphics protocol (kitty, WezTerm, Ghostty, recent Konsole) are used in preference to sixel, which remains the fallback for older terminals. Redirecting or piping stdout always keeps the raw bytes. Set `SENTRY_NO_GRAPHICS=1` (or run `sentry cli defaults graphics off`) to disable inline rendering; `SENTRY_NO_SIXEL` is still honored as a deprecated alias.

For full API documentation, see the [Sentry API Reference](https://docs.sentry.io/api/).
