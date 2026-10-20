# Sources

This file records the source material synthesized into `mcp-audit`.

## Selected profile

- `workflow-process`
- Selected example profile: `skill-writer/references/examples/workflow-process-skill.md`

## Current source inventory

| Source                                                                            | Type                     | Trust tier | Retrieved  | Confidence | Contribution                                                                                                                       | Usage constraints                                            | Notes                                     |
| --------------------------------------------------------------------------------- | ------------------------ | ---------- | ---------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------- |
| `https://modelcontextprotocol.io/specification/2025-11-25/server/tools`           | external spec            | canonical  | 2026-04-21 | high       | Anchored tool-definition, annotation, tool-result, and task-support guidance                                                       | Released spec baseline, not draft                            | Primary tools source                      |
| `https://modelcontextprotocol.io/specification/2025-11-25/schema`                 | external schema          | canonical  | 2026-04-21 | high       | Confirmed field-level wire shape for tool metadata and tool results                                                                | Released schema baseline, not draft                          | Used for precise field coverage           |
| `https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle`        | external spec            | canonical  | 2026-04-21 | high       | Anchored initialize and initialized flow plus capability negotiation guidance                                                      | Released spec baseline, not draft                            | Lifecycle audit source                    |
| `https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization`    | external spec            | canonical  | 2026-04-21 | high       | Anchored protected-resource metadata, `WWW-Authenticate`, scope, and audience guidance                                             | Applies to HTTP-capable servers, not pure `stdio` servers    | Auth audit source                         |
| `https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices` | external guidance        | canonical  | 2026-04-21 | high       | Added concrete security checks around local server compromise, DNS rebinding, SSRF-adjacent exposure, consent, and least privilege | Best-practices guidance, not a version-pinned normative spec | Security audit source                     |
| `https://modelcontextprotocol.io/specification/2025-11-25/server/index`           | external spec            | canonical  | 2026-04-21 | high       | Reinforced the control hierarchy across prompts, resources, and tools                                                              | Released spec baseline, not draft                            | Used for control-boundary guidance        |
| `https://modelcontextprotocol.io/specification/2025-11-25/changelog`              | external changelog       | canonical  | 2026-04-21 | high       | Captured released-version deltas to watch for in older repos                                                                       | Released changelog only                                      | Used for compatibility watchpoints        |
| `https://modelcontextprotocol.io/specification/draft/changelog`                   | external draft changelog | canonical  | 2026-04-21 | medium     | Captured draft-only watchpoints that should not be enforced as current released requirements                                       | Draft only, do not enforce by default                        | Used for version-watchpoint separation    |
| `docs/adding-tools.md`                                                            | repo doc                 | canonical  | 2026-04-21 | high       | Supplied local tool-count guidance and repo-specific metadata conventions layered on top of the spec                               | Repo-local semantics may differ elsewhere                    | Local compatibility source                |
| `docs/quality-checks.md`                                                          | repo doc                 | canonical  | 2026-04-21 | high       | Confirmed that audits should refresh generated definitions and finish with repo validation when appropriate                        | Repo-local workflow requirement                              | Validation guidance source                |
| `packages/mcp-core/src/server.test.ts`                                            | local example            | contextual | 2026-04-21 | high       | Demonstrated why exported wire metadata should be verified, not just source declarations                                           | Example only, not portable guidance                          | Informed real-surface validation guidance |
| `packages/mcp-core/src/tools/tools.test.ts`                                       | local example            | contextual | 2026-04-21 | high       | Showed the shape of narrow structural checks without hardcoding a repo-specific inventory into the skill body                      | Example only, not portable guidance                          | Informed automation guidance              |
| `skill-writer/references/mode-selection.md`                                       | authoring guide          | canonical  | 2026-04-21 | high       | Confirmed `workflow-process` as the right class for this skill                                                                     | Applies to skill authoring, not audit execution              | Guided class selection                    |
| `skill-writer/references/synthesis-path.md`                                       | authoring guide          | canonical  | 2026-04-21 | high       | Required broader source coverage, provenance, and depth gates before revising the skill                                            | Applies to skill authoring, not audit execution              | Guided synthesis coverage                 |
| `skill-writer/references/examples/workflow-process-skill.md`                      | authoring guide          | contextual | 2026-04-21 | medium     | Reinforced preconditions, ordered flow, safety boundaries, and failure handling as first-class artifacts                           | Example only                                                 | Used as structure prior art               |

## Coverage matrix

| Dimension                            | Coverage status | Sources                                        | Notes                                                                                            |
| ------------------------------------ | --------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Released spec baseline               | complete        | tools spec, schema, lifecycle, server overview | Latest released baseline confirmed as `2025-11-25`                                               |
| Lifecycle and capability negotiation | complete        | lifecycle spec, server overview                | Includes initialize, initialized, claimed capabilities, and control hierarchy                    |
| Tools and structured output          | complete        | tools spec, schema, local server-test example  | Expanded beyond hints into titles, icons, schemas, execution metadata, and tool-result semantics |
| Prompts and resources                | complete        | server overview plus released spec synthesis   | Added explicit audit branches even when a repo only implements tools today                       |
| Transport, auth, and security        | complete        | authorization spec, security best practices    | Separated `stdio` from HTTP-specific checks                                                      |
| Version and draft variance           | complete        | released changelog, draft changelog            | Added watchpoints so the skill does not over-enforce unreleased behavior                         |
| Repo-local compatibility rules       | complete        | adding-tools, quality-checks, local tests      | Kept the skill generic while preserving local generation and validation expectations             |

## Decisions

1. Keep the skill generic and portable; do not hardcode project-specific commands, paths, or mutation inventories into `SKILL.md`.
2. Expand the audit from tool hints alone to the full MCP surface the repo may expose: lifecycle, capabilities, tools, prompts, resources, transports, auth, security, and version drift.
3. Default to the latest released MCP spec when a repo does not pin an older version.
4. Treat draft and SEP content as watchpoints unless the repo explicitly opts into draft compatibility.
5. Prefer exported wire behavior over local declarations whenever frameworks can transform metadata before clients see it.

## Open gaps

1. The security best-practices guide is not version-pinned, so re-check it when the MCP site updates its threat model guidance.
2. Prompt- and resource-specific released spec pages can be added on the next revision if this skill needs even deeper prompt or resource troubleshooting examples.

## Stopping rationale

Additional retrieval would have been low-yield for this revision. The current source pack covers:

1. the latest released MCP wire contract
2. release and draft version drift
3. security and authorization guidance
4. repo-local compatibility rules
5. workflow-process authoring requirements

That was enough to rewrite `mcp-audit` into a broader protocol audit without inventing non-authoritative requirements.

## Changelog

- 2026-04-21: Created `mcp-audit` as a generic workflow-process skill for MCP metadata and compatibility audits.
- 2026-04-21: Expanded the skill from a narrow hint audit into a broader released-spec protocol audit covering lifecycle, capabilities, tools, prompts, resources, transports, auth, security, and version drift.
