# Toolkit core

Pure protocol and hostname helpers shared by the CLI and MCP. Both product
builds bundle this private workspace package into their artifacts.

The shared code validates and formats upstream bearer tokens, assembles Sentry
API URLs, constructs OAuth device-flow form bodies, classifies RFC 8628 polling
responses, advances retry intervals, recognizes Sentry hostnames and
credential-safe SaaS HTTPS origins, encodes API path identifiers, and deduplicates
in-flight region lookups. Each product retains its own credential storage,
regional cache identity and persistence, host allowlists, routing, polling
deadline, HTTP transport, response validation, and user-facing errors.

The `resource-identity` types describe the identifiers shared by organization,
project, team, and issue responses. CLI overlays retain SDK-derived string IDs;
MCP schemas accept numeric IDs too and check their parsed outputs against these
types. Each product keeps its own response validation.
