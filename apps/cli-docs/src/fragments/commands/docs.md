

## Reading results

Each result is a page title and its Markdown URL. Fetch the URL to read the
page; `.md` pages are plain Markdown, which is cheaper for agents than HTML.
`--json` adds each page's description and parent sections.

## Queries

- **Words** rank pages; a page that matches more of them comes first, so one
  query can combine topics: `sentry docs tracing cloudflare tanstack start`.
  Quotes, case, and punctuation are ignored, filler such as "how do I" is
  dropped, and a small typo is corrected with a note.
- **`-e <regex>`** keeps pages whose URL path or title matches, like
  `grep -e`. Matching ignores case; repeat `-e` to match any of several
  patterns. An invalid pattern is searched as words instead of failing.
- **A docs URL or path** returns that page.

Docs paths follow `/platforms/<language>/guides/<framework>/<feature>`, for
example `/platforms/javascript/guides/nextjs/tracing`.

## Caching

The search runs locally against docs.sentry.io's page index, so it needs no
login and works with self-hosted Sentry. The index is cached under the CLI
config directory and checked for changes every 6 hours; `--fresh` checks
now, and `SENTRY_NO_CACHE=1` skips the cache.
