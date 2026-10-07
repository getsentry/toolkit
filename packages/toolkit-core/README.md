# Toolkit core

Pure protocol and hostname helpers shared by the CLI and MCP. Both product
builds bundle this private workspace package into their artifacts.

The shared code validates and formats upstream bearer tokens, assembles Sentry
API URLs, constructs OAuth device-flow form bodies, classifies RFC 8628 polling
responses, advances retry intervals, recognizes Sentry hostnames, and encodes
API path identifiers. Each product retains its own credential storage, host
trust checks, regional routing, polling deadline, HTTP transport, response
validation, and user-facing errors.
