# Toolkit core

Pure authentication protocol helpers shared by the CLI and MCP. Both product
builds bundle this private workspace package into their artifacts.

The shared code validates opaque bearer tokens, constructs OAuth device-flow
form bodies, and applies the RFC 8628 polling interval rule. Each product
retains its own credential storage, host trust checks, polling deadline, HTTP
transport, response validation, and user-facing error types.
