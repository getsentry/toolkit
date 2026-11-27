# Token Cost Tracking

Measures the static overhead of MCP tool definitions - the tokens sent to LLM clients with every request.

## What's Being Measured

The token cost of tool metadata that MCP sends to clients via `tools/list`:

- Tool names and descriptions
- Parameter schemas (JSON Schema)
- Output schemas (`outputSchema`, JSON Schema) for tools that declare one
- Total overhead per tool and across all tools

**Exclusions:**

- Runtime token usage by embedded agents (search_events, search_issues, search_issue_events)

## Running Locally

**Display table (default):**

```bash
pnpm run measure-tokens
```

**Output:**

```
📊 MCP Server Token Cost Report
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total Tokens:     75,759
Tool Count:       73
Average/Tool:     1,038
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Per-Tool Breakdown:

┌─────────────────────────────┬────────┬─────────┐
│ Tool                        │ Tokens │ % Total │
├─────────────────────────────┼────────┼─────────┤
│ get_alert_rule              │   2517 │    3.3% │
│ find_releases               │   2033 │    2.7% │
│ update_alert_rule           │   1975 │    2.6% │
...
```

**Write JSON to file:**

```bash
# From repository root
pnpm run measure-tokens -- -o token-stats.json

# Or from mcp-core package
cd packages/mcp-core
pnpm run measure-tokens -- -o token-stats.json
```

JSON format:

```json
{
  "total_tokens": 75759,
  "tool_count": 73,
  "avg_tokens_per_tool": 1038,
  "tools": [
    {"name": "get_alert_rule", "tokens": 2517, "percentage": 3.3},
    ...
  ]
}
```

## CI/CD Integration

GitHub Actions workflow runs on every PR and push to main:

**On Pull Requests:**

- 📝 **PR Comment:** Full report, posted only when the tool definitions or MCP
  Apps views differ from main's last run. Once posted, it is updated on each push.
  Lockfile-only changes that leave the MCP surface alone get no comment.
- 📊 **Job Summary:** Detailed per-tool breakdown in Actions tab
- 📦 **Artifact:** `token-stats-{sha}.json` stored for 90 days

**On Main Branch:**

- 📊 **Job Summary:** Detailed per-tool breakdown in Actions tab
- 📦 **Artifact:** `token-stats-{sha}.json` stored for 90 days

**Workflow:** `.github/workflows/token-cost.yml`

## MCP Apps View Size

The same workflow measures each MCP Apps view, the `ui://` HTML that a host
such as Claude, VS Code, or ChatGPT downloads to render a tool result. The
script builds the server with every skill, lists its resources, and reads each
`ui://` resource through `resources/read`, so a new view shows up without a
script change.

```bash
pnpm --filter @sentry/mcp-core measure-ui                      # Display
pnpm --filter @sentry/mcp-core measure-ui -- -o ui-stats.json  # Write JSON
```

Per view it reports raw, gzip (level 9), and brotli (quality 11) bytes, and raw
bytes as a percentage of the view's `budgetBytes` in `src/ui-resources.ts`.
The report adds an "MCP Apps views" section to the PR comment and job summary,
and `ui-stats.json` goes into the `token-stats-{sha}` artifact. The budget is
enforced by the view's generator, such as `generate-chart-app`, not by this
report; see [design/mcp-apps.md](../../design/mcp-apps.md).

## Understanding the Results

Run `pnpm run measure-tokens` for current numbers; the examples above are a
snapshot and go stale.

**Tool count limits:** the gateway surface (`TOP_LEVEL_TOOL_NAMES`) targets ≤20
tools, hard limit 25. `EXPOSE_ALL_TOOLS` lists every tool and relies on harness
tool search.

**When to investigate:**

- Total tokens increase >10% without new tools or new output schemas
- A tool sits well above the average (check the top of the per-tool table)
- A new tool, or a new output schema, adds far more than its neighbours

## Implementation Details

**Tokenizer:** Uses `tiktoken` with GPT-4's `cl100k_base` encoding (good approximation for Claude).

**Script location:** `packages/mcp-core/scripts/measure-token-cost.ts`

**CLI options:**

```bash
pnpm run measure-tokens                   # Display table
pnpm run measure-tokens -- -o file.json   # Write JSON to file
pnpm run measure-tokens -- --help         # Show help
```

## Optimizing Token Cost

**Reduce description verbosity:**

- Be concise - LLMs don't need hand-holding
- Remove redundant examples
- Focus on unique, non-obvious details

**Simplify parameter and output schemas:**

- Use `.describe()` sparingly
- Avoid duplicate descriptions in nested schemas
- Combine related parameters

**Consolidate tools:**

- Before adding a new tool, check if existing tools can handle it
- Consider parameter variants instead of separate tools

## References

- Script: `packages/mcp-core/scripts/measure-token-cost.ts`
- Workflow: `.github/workflows/token-cost.yml`
- Tool limits: See "Tool Count Limits" in
  [../contributing/adding-tools.md](../contributing/adding-tools.md)
