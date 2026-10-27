# Toolkit core

Pure protocol and hostname helpers shared by the CLI and MCP. Both product
builds bundle this private workspace package into their artifacts.

The shared code validates and formats upstream bearer tokens, assembles Sentry
API URLs, constructs OAuth device-flow form bodies, classifies RFC 8628 polling
responses, advances retry intervals, decides when a Sentry API request may
be retried and how long to wait (`api-retry`), recognizes Sentry hostnames and
credential-safe SaaS HTTPS origins, encodes API path identifiers, parses Events
field expressions the way the Sentry frontend does, parses search queries with
the Sentry frontend grammar, resolves Events endpoint sorts so the sort column
is always selected, and deduplicates in-flight region lookups. Each product
retains its own credential storage, regional cache identity and persistence,
host allowlists, routing, polling
deadline, HTTP transport, response validation, and user-facing errors.

## Pagination

`pagination` walks Sentry list endpoints up to a row limit. `paginate` splits
the limit evenly over the fewest requests (at most 100 rows each), reuses the
page size a page-number cursor encodes, and returns a cursor that resumes at
the first row the caller has not received, even when the walk stopped inside
a page. Those cursors are still valid Sentry cursors: the rows already
returned are written into the `is_prev` field in a form Sentry reads as 0, so
the API and older CLIs accept them. `fetchAllPages` reads every page or
reports why it could not (an invalid page, a repeated cursor, or the page
cap), for callers whose result a mutation depends on.

The module does no I/O. The caller fetches each page, validates rows, sets
the page cap, receives warnings, and turns failures into its own errors. The
CLI's `paginate` and `fetchAllPages` in
`packages/cli/src/lib/api/infrastructure.ts` are thin wrappers over it.

## Resource identity

The `resource-identity` types describe the identifiers shared by organization,
project, team, and issue responses. CLI overlays retain SDK-derived string IDs;
MCP schemas accept numeric IDs too and check their parsed outputs against these
types. Each product keeps its own response validation.

## Search syntax

`search-syntax` parses Sentry search queries with the Sentry frontend's own
grammar. `grammar/search-syntax.pegjs` is an unchanged copy of
[`static/app/components/searchSyntax/grammar.pegjs`](https://github.com/getsentry/sentry/blob/master/static/app/components/searchSyntax/grammar.pegjs),
and `test/fixtures/search-syntax/` is a copy of the `fixtures/search-syntax`
cases the frontend and `event_search.py` both test against. `parseSearch`
returns the frontend's token tree, minus validation: `TokenConverter` never
marks tokens invalid or fills `parsed` values. A product that needs those
subclasses `TokenConverter` and passes it as `converter`.

`search-query` uses that parser to rewrite queries the API would reject:
explicit `AND` is dropped, and `OR` on one key becomes an in-list. With
`issueSearch: true` it also turns `is:` OR groups into `status:[…]` or
`substatus:[…]` and unwraps parentheses, which the issues endpoint doesn't
support. It returns the rewrite notes and throws `SearchQueryError` for
anything it can't rewrite; each product decides how to report them.

The parser is compiled ahead of time into `src/generated/` and committed,
since this package has no build step. Its types live in
`grammar/search-syntax.d.ts`. After editing either file, run
`pnpm run generate:parsers`; the pre-commit hook does this for staged
grammar changes, and `pnpm run check:generated` fails in CI when
the committed parser is out of date. When updating the grammar from upstream,
copy the fixtures too.
