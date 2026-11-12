# Toolkit core

Pure protocol and hostname helpers shared by the CLI and MCP. Both product
builds bundle this private workspace package into their artifacts.

The shared code constructs OAuth device-flow form bodies, classifies RFC 8628
polling responses, advances retry intervals, recognizes Sentry hostnames and
credential-safe SaaS HTTPS origins, parses Events
field expressions the way the Sentry frontend does, parses search queries with
the Sentry frontend grammar, resolves Events endpoint sorts so the sort column
is always selected, and deduplicates in-flight region lookups. Each product
retains its own credential storage, regional cache identity and persistence,
host allowlists, routing, polling deadline, response validation, and
user-facing errors.

## API client

The shared Sentry API client (request core, transport, retry policy,
pagination, response cache policy, errors, and endpoint wrappers) is
`@sentry/api/client` and `@sentry/api/client/endpoints`, published from
[getsentry/sentry-api-schema](https://github.com/getsentry/sentry-api-schema#shared-client),
so the CLI, the MCP, and other hosts share one copy. That includes bearer token
validation, API URL assembly, and path identifier encoding.

## Response cache codec

`response-cache/codec` compresses cached response bodies with `node:zlib`, so
it stays here rather than in the portable client: zstd level 3 where the
runtime has it (Node 22.15+, Workers with `nodejs_compat`), brotli quality 4
otherwise, and no compression below 256 bytes. It implements the client's
`BodyCodec`. Each entry records its encoding and original size; `decode`
returns `undefined` for an entry this runtime cannot read, such as zstd on
older Node, so the caller treats it as a miss.

## Markdown

`markdown` builds Markdown for untrusted values. Pick the helper by what the
value is: `inlineCode` for identifiers and short values, `codeBlock` for
multi-line data, and `text` for values that should read as prose. Each keeps
the value inside the line or block it is placed in, so the value cannot add
headings, list items, links, or other structure. `inlineCode` and `codeBlock`
need no escaping; `text` escapes with backslashes only and has no runtime
dependencies. The property tests parse each helper's output with `marked`, the
parser the CLI renders with (same version, from the workspace catalog), and
with micromark, the CommonMark reference parser, and check that any input
round-trips as the same literal value.

`tableCell` is `text` plus escaped pipes, for a value in a GFM table cell. The
CLI and MCP both import these helpers, so their output escapes the same way. Escaped text never becomes a literal autolink: a URL in upstream data
stays plain text.

## Resource identity

The `resource-identity` types describe the identifiers shared by organization,
project, team, and issue responses. CLI overlays retain SDK-derived string IDs;
MCP schemas accept numeric IDs too and check their parsed outputs against these
types. Each product keeps its own response validation.

## Search syntax

Search queries are parsed with
[`@sentry/search-syntax`](https://www.npmjs.com/package/@sentry/search-syntax),
the Sentry frontend's own grammar and structural parser, published from
[`static/packages/search-syntax`](https://github.com/getsentry/sentry/tree/master/static/packages/search-syntax)
in getsentry/sentry. Grammar changes and their tests (including the
`fixtures/search-syntax` cases shared with `event_search.py`) live there.

`search-query` uses that parser to rewrite queries the API would reject:
explicit `AND` is dropped, and `OR` on one key becomes an in-list. With
`issueSearch: true` it also turns `is:` OR groups into `status:[…]` or
`substatus:[…]` and unwraps parentheses, which the issues endpoint doesn't
support. It returns the rewrite notes and throws `SearchQueryError` for
anything it can't rewrite; each product decides how to report them.
