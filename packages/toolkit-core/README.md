# Toolkit core

Pure authentication protocol helpers shared by the CLI and MCP. Both product
builds bundle this private workspace package into their artifacts.

The shared code validates opaque bearer tokens and constructs OAuth device-flow
form bodies. Each product retains its own credential storage, host trust checks,
HTTP transport, response validation, and user-facing error types.
