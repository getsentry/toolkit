# MCP Apps views

A host that supports MCP Apps, such as Claude or VS Code, renders a Sentry
tool result as an interactive view inline in the conversation. Every other
client gets the same answer as text.

## Intent

- A view is an optional enhancement. A tool with a view gives every client
  the complete answer, so a text-only client or a host without MCP Apps loses
  nothing but the picture.
- The model never relays data to a view. A tool with a view takes a query,
  and the server fetches the data from Sentry, so what the view shows comes
  from Sentry, not from model output.
- A view costs a session nothing until a host renders it, and little when
  one does. Views speak the MCP Apps protocol directly, with no SDK or schema
  library, so adding one barely grows the server.
- A view is safe in any host's sandbox. It trusts nothing that it receives
  and reaches nothing outside the host.

## Entry points

- The `render_sentry_chart` chart in an MCP Apps host, with its range picker,
  fullscreen, and Open in Sentry buttons, in experimental sessions.
- `ui://` resources in `resources/list` and `resources/read`, named by a
  tool's `_meta.ui.resourceUri` (and `openai/outputTemplate` for ChatGPT).

## Rules

- MCP Apps ship in experimental sessions only, until real hosts are
  verified. A tool with a view is marked `experimental`, so a stable
  session lists neither the tool nor its view, and skill prompts do not
  advertise it.
- A tool with a view is listed for every client that can call it, and its
  result is the same for every client. A view shows nothing that the result
  does not hold.
- A tool with a view takes a query, not values. Follow-up calls from the
  view, such as a new time range, call the same tool through the host.
- A view is one self-contained HTML document with inline scripts and
  styles. Its declared CSP lists no origins, and it loads nothing from the
  network: no remote scripts, styles, fonts, or images, and no requests.
- Each view has a hard byte limit, and the build fails when the view
  exceeds it. The chart's limit is 24 KiB.
- A view's `ui://` URI carries a version, and any change to the view's HTML
  ships under a new version, because hosts cache views by URI.
- A view treats the tool result and every host message as untrusted. It
  parses the result into its own shape at the boundary, shows an error state
  instead of drawing data in the wrong shape, and writes text only as text.
- A session lists a view only when it lists a tool that names it. A session
  with no such tool declares no resources capability.
- Views are not gated on the client advertising MCP Apps support
  (`capabilities.extensions["io.modelcontextprotocol/ui"]`). The remote
  server builds a new session for each HTTP request, so it cannot see what
  the client sent in `initialize` when it answers `tools/list`. Gating there
  would hide views from Claude, VS Code, and ChatGPT, which all advertise
  support. Hosts that render without advertising, such as the ext-apps
  reference host, would also lose them. Instead, the server loads a view's
  HTML only when a host reads the view, so a text-only session never loads
  it.
- A view follows the host's theme, locale, and time zone.
- A view uses a host feature, such as fullscreen or model context updates,
  only when the host advertises it, and works the same without it.
- When the user changes what a view shows, such as the chart's range, the
  view tells the model with `ui/update-model-context`, so the model answers
  about what the user sees and not the first result.

## Gaps

- Rendering is proven only against the ext-apps reference host
  (`mcp-apps#real-hosts`). Claude, VS Code, ChatGPT, and Codex are not
  verified, so "every MCP Apps host renders the view" is unproven.
- The spec says servers SHOULD check client capabilities before they list
  UI tools. Sessions that cannot render, such as the Codex and Goose CLIs,
  still get `_meta.ui` and a listed view. They never load its HTML. This
  falls short of "costs a session nothing" by one tool `_meta` key and one
  resource entry. Gating can follow once the remote server sees client
  capabilities on each request, as the draft protocol's per-request
  capabilities allow.
