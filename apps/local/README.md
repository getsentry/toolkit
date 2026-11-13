# Sentry Local viewer

The viewer connects to a Local receiver and inspects captured SDK envelopes.
Start the receiver and UI in separate terminals from the repository root:

```sh
pnpm --filter sentry run cli local serve
pnpm --filter local dev
```

Open the URL printed by Vite and connect to `http://localhost:8969`.
The receiver can also be a named Local session or an explicitly selected remote
receiver. Capture lifecycle and retention are managed through the existing
Local controls.

## Replay example captures

With a receiver running, load all bundled examples:

```sh
pnpm --filter local sample
```

The examples cover correlated errors/logs/traces, repeated database queries,
resource loading, Web Vitals, an AI conversation and tool execution, feedback,
SDK reports, legacy and continuous profiles, standalone span-v2 telemetry,
and text/JSON/HTML/image attachments. All names and content are synthetic.
They follow the SDK envelope shapes used in Spotlight's fixture corpus.

Replay any directory of raw SDK envelopes, including Spotlight's `_fixtures`
directory, recursively:

```sh
pnpm --filter local sample /path/to/spotlight/packages/spotlight/_fixtures \
  --endpoint http://localhost:8969/stream --compression gzip

pnpm --filter local sample --interval 200 --repeat 3
```

`--fixtures` is an alternative to the positional path. `--endpoint` takes
precedence over `SENTRY_SPOTLIGHT`; otherwise the default is
`http://localhost:8969/stream`. A named session requires its ingestion endpoint,
not its capability-protected viewer stream URL.

The loader sends `.txt`, `.bin`, and `.envelope` files in sorted order, preserving
raw bytes and captured timestamps. Bundled byte-counted envelopes disable Git
line-ending conversion; preserve the original bytes when checking out external
captures as well. `--compression` supports `none`, `gzip`, and
`br`; `--interval` is milliseconds between envelopes and `--repeat` is a finite
number of passes. It stops with a nonzero exit status when a request is rejected
or times out. The command does not clear existing capture history. Raise the
receiver's envelope retention limit when replaying a large corpus.

## Investigation views

- Errors include exception causes, captured source lines and local variables,
  breadcrumbs, request/context data, tags, modules, VS Code links for absolute
  local paths, a copyable Markdown summary for AI assistants, and the
  attachments the SDK sent for the event (collapsed until previewed).
- AI inspection reads standard `gen_ai.*` and Vercel AI fields from both embedded
  transaction spans and standalone spans. Prompts, responses, token usage and
  tool arguments/results appear when the SDK captured them. Child AI steps stay
  linked to their parent interaction. Interaction summaries use captured child
  metadata, reconcile parent/step token totals, and pair the latest response
  with its finish reason. Empty or malformed aliases do not hide usable content.
- Queries and resources group exact operation/description pairs. Sort by count,
  duration or captured resource size and open an execution in its trace.
- Web Vitals groups visits by page and shows individual captured measurements.
  LCP, INP, CLS, FCP and TTFB use the [Web Vitals thresholds](https://web.dev/articles/vitals);
  FID is labelled as a legacy metric. Local samples are not field percentiles.
- Profiles support Sentry sample/stack/frame payloads in legacy `profile` items
  and continuous `profile_chunk` items. Select a thread, compare inclusive/self
  time and samples, and explore flame, treemap or sunburst views. Observed time
  uses adjacent samples on each thread within a captured chunk; no duration is
  invented across missing chunks or after a final sample. Retained chunks from
  the same profiler can be viewed together or individually. Sampled functions
  appear in associated trace waterfalls where captured span timing identifies
  their parent unambiguously. These rows are labelled as sampled and capped at
  5,000 per trace. Charts limit displayed depth/nodes for responsiveness; JSON
  preserves the selected original payload.
- SDKs lists observed names, versions, platforms and last-seen metadata, followed
  by session/client reports. Feedback links to associated errors in the capture.
- Attachments show safe text/JSON/image/video previews and downloads. Captured
  HTML, SVG and code remain inert; the viewer never executes them or fetches
  captured resource URLs. Attachments inside a raw envelope stay collapsed and
  are decoded only when you show their preview.

Use severity/logger filters and sorting in event/log views. The Columns control
chooses which metadata appears beside each message. In a trace, search spans,
show only matches, collapse branches, or adjust the tree width.

## Tests

```sh
pnpm --filter local test
pnpm --filter local typecheck
pnpm --filter local build
```

Integration tests start an actual receiver, replay the bundled capture through
HTTP/SSE, then navigate the analysis and inspector views. Replay tests cover
binary bytes, gzip/Brotli, recursive directories, repeated passes and rejected
requests. Unknown payloads remain inspectable as JSON.

Envelope decoding and retention live directly in Local and the CLI, without a
Spotlight package dependency. Spotlight-compatible health and envelope headers
remain supported so existing Sentry SDK transports can keep sending captures.

The receiver accepts gzip, deflate and Brotli with a 10 MiB encoded-body limit
and a 32 MiB decoded-body limit. Missing or plain-text content types use the
envelope format. Invalid compression returns 400, oversized input 413,
unsupported media/encoding 415, and temporary admission overload 503. Malformed
envelopes remain listed and downloadable by their receiver ID; downloads retain
the original bytes while the text preview is best effort. Retention remains
bounded by the configured envelope count.
