# MCP Audit Checklist

Use this checklist for repeatable MCP protocol and compatibility audits in any repository.

## Baseline and scope

1. Identify the protocol revision being audited.
2. Default to the latest released MCP spec when the repo does not pin an older revision.
3. Identify which server primitives are implemented:
   - prompts
   - resources
   - tools
   - completions
   - logging
   - tasks or experimental extensions
4. Identify which transports are supported:
   - `stdio`
   - HTTP or Streamable HTTP
   - hosted or reverse-proxied transport owned outside the repo
5. Separate released-spec requirements from draft-only or SEP-only watchpoints.

## Lifecycle and capabilities

1. Verify `initialize` and `notifications/initialized` behavior.
2. Verify protocol-version negotiation and any required transport headers after initialization.
3. Verify the server advertises only capabilities it actually supports.
4. Verify capability sub-flags such as `listChanged`, `subscribe`, or task-related blocks are accurate.
5. Verify unsupported primitives are omitted rather than stubbed or falsely advertised.

## Tools

1. Verify `tools/list` behavior, including pagination if the server can emit large tool sets.
2. Verify `notifications/tools/list_changed` only if the capability is claimed.
3. Verify exported tool definitions from the real server surface, not only source declarations.
4. Check tool metadata:
   - `name`
   - `title`
   - `description`
   - `icons`
   - `inputSchema`
   - `outputSchema`
   - `annotations`
   - `execution.taskSupport`
5. Check tool result behavior:
   - `content`
   - `structuredContent`
   - `isError`
   - resource links or embedded resources
6. Verify tool execution failures are distinguished from protocol-level JSON-RPC failures.
7. Build an explicit list of tools that mutate upstream state.
8. Classify each mutation:
   - additive write
   - destructive update
9. Treat orchestration tools conservatively based on the strongest child tool they can reach.
10. Treat conditional writes as mutating even if the write happens only on some code paths.
11. Verify safety hints:

- every tool defines `readOnlyHint`
- every tool defines `openWorldHint`
- every write-capable tool defines `destructiveHint`
- only truly repeatable no-extra-effect tools define `idempotentHint`
- read-only tools are never marked destructive

12. Verify `structuredContent` matches `outputSchema` when `outputSchema` is declared.
13. Verify tool naming rules against the targeted spec revision.

## Prompts and resources

1. If prompts are implemented:
   - verify prompts capability declaration
   - verify `prompts/list` and pagination behavior
   - verify `prompts/get`
   - verify `notifications/prompts/list_changed` only if claimed
   - verify prompt argument handling and prompt message content types
2. If resources are implemented:
   - verify resources capability declaration
   - verify `resources/list` and pagination behavior
   - verify `resources/read`
   - verify `resources/templates/list` if templates exist
   - verify `resources/subscribe` and `notifications/resources/updated` only if claimed
   - verify `notifications/resources/list_changed` only if claimed
   - verify URI handling, MIME types, and text/blob encoding
3. Preserve the control hierarchy:
   - prompts are user-controlled
   - resources are application-controlled
   - tools are model-controlled

## Transport, auth, and security

1. For `stdio`:
   - stdout is reserved for protocol messages
   - logs and diagnostics stay on stderr
   - credentials come from environment or local config, not HTTP auth redirects
2. For HTTP or Streamable HTTP:
   - verify origin validation
   - verify local deployments bind safely and do not expose a permissive local server by default
   - verify session and protocol-version handling if the repo owns transport code
3. For authorization:
   - verify protected resource metadata discovery
   - verify `WWW-Authenticate` challenges include the right metadata or scope guidance
   - verify resource indicators or audience binding where applicable
   - verify bearer tokens are not accepted through query parameters
4. For security:
   - validate external input and URIs
   - check access controls and least-privilege defaults
   - check output sanitization for tool or resource content
   - check rate limits, timeouts, and SSRF or DNS-rebinding exposure where relevant

## Version drift and compatibility

1. Check the latest released spec for newer fields or behaviors that the repo may have missed.
2. Record older-target behavior separately from actual violations.
3. Record draft-only watchpoints separately from released-spec violations.
4. Check repo or host compatibility constraints:
   - tool count limits
   - description-length limits
   - generated definitions
   - Inspector, SDK, or IDE quirks
   - Warden or CI rules

## Automation expectations

1. Prefer an existing repo-local integration test or metadata audit command if one exists.
2. If no focused audit exists, add or update the narrowest automated check that:
   - captures the mutating-tool inventory when tool hints are involved
   - validates claimed protocol metadata
   - verifies exported wire behavior when frameworks can transform definitions
3. Refresh generated definitions or catalogs after metadata changes if the repo uses them.
4. Finish with the repo's normal validation commands when appropriate.

## Reporting

1. State the audited protocol baseline.
2. List every primitive and capability the server implements.
3. List every upstream-mutating tool.
4. List every confirmed incompatibility with file references.
5. Separate released-spec violations, compatibility risks, and draft watchpoints.
6. State what was verified through source inspection versus the real server surface.
7. State whether generation and validation checks passed.
