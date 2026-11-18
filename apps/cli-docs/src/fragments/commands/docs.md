

## Reading results

Each result is a page title and its Markdown URL. Fetch the URL to read the
page; `.md` pages are plain Markdown, which is cheaper for agents than HTML.
`--json` adds each page's description and parent sections.

## Queries

- **Words** rank pages; a page that matches more of them comes first, so one
  query can combine topics: `sentry docs tracing cloudflare tanstack start`.
  Quotes, case, and punctuation are ignored, filler such as "how do I" is
  dropped, other forms of a word count (`filter` finds "Filtering"), and a
  small typo is corrected with a note.
- **A platform or framework word** narrows the results: with `python` or
  `nextjs` in the query, other platforms' pages come last, and `django` or
  `fastapi` favors Python's pages.
  Without one, a page that every platform has, such as "Scrubbing Sensitive
  Data", is listed once with a note.
- **`-e <regex>`** keeps pages whose URL path or title matches, like
  `grep -e`. Matching ignores case; repeat `-e` to match any of several
  patterns. An invalid pattern, or one that repeats an ambiguous group such
  as `(a+)+` and could run for minutes, is searched as words instead of
  failing.
- **A docs URL or path** returns that page.

Docs paths follow `/platforms/<language>/guides/<framework>/<feature>`, for
example `/platforms/javascript/guides/nextjs/tracing`.

## Caching

The search runs locally against docs.sentry.io's page index, so it needs no
login and works with self-hosted Sentry. The index is cached under the CLI
config directory and checked for changes every 6 hours; `--fresh` checks
now, and `SENTRY_NO_CACHE=1` skips the cache.
