# Toolkit core

Pure protocol and hostname helpers shared by the CLI and MCP. Both product
builds bundle this private workspace package into their artifacts.

The shared code validates opaque bearer tokens, constructs OAuth device-flow
form bodies, applies the RFC 8628 polling interval rule, and recognizes Sentry
hostnames. Each product retains its own credential storage, URL and host trust
checks, regional routing, polling deadline, HTTP transport, response validation,
and user-facing error types.
