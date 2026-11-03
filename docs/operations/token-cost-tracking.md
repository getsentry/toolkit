# Token Cost Tracking

Measures the static overhead of MCP tool definitions - the tokens sent to LLM clients with every request.

## What's Being Measured

The token cost of tool metadata that MCP sends to clients via `tools/list`:

- Tool names and descriptions
- Parameter schemas (JSON Schema)
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
Total Tokens:     14,068
Tool Count:       24
Average/Tool:     586
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Per-Tool Breakdown:

┌─────────────────────────────┬────────┬─────────┐
│ Tool                        │ Tokens │ % Total │
├─────────────────────────────┼────────┼─────────┤
│ search_events               │   1192 │    8.5% │
│ update_issue                │   1166 │    8.3% │
│ search_docs                 │    975 │    6.9% │
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
  "total_tokens": 14068,
  "tool_count": 24,
  "avg_tokens_per_tool": 586,
  "tools": [
    {"name": "search_events", "tokens": 1192, "percentage": 8.5},
    ...
  ]
}
```

## CI/CD Integration

GitHub Actions workflow runs on every PR and push to main:

**On Pull Requests:**

- 📝 **PR Comment:** Automatic comment with full report (updated on each push)
- 📊 **Job Summary:** Detailed per-tool breakdown in Actions tab
- 📦 **Artifact:** `token-stats-{sha}.json` stored for 90 days

**On Main Branch:**

- 📊 **Job Summary:** Detailed per-tool breakdown in Actions tab
- 📦 **Artifact:** `token-stats-{sha}.json` stored for 90 days

**Workflow:** `.github/workflows/token-cost.yml`

## Understanding the Results

- ~14,068 tokens total
- ~586 tokens/tool average

**Tool count limits:**

- **Target:** ≤20 tools (current best practice)
- **Maximum:** ≤25 tools (hard limit for AI agents)

**When to investigate:**

- Total tokens increase >10% without new tools
- Individual tool >1,000 tokens (indicates overly verbose descriptions)
- New tool adds >500 tokens (review description clarity)

## Implementation Details

**Tokenizer:** Uses `tiktoken` with GPT-4's `cl100k_base` encoding (good approximation for Claude).

**Script location:** `packages/mcp-core/scripts/measure-token-cost.ts`

**CLI options:**

```bash
tsx measure-token-cost.ts              # Display table
tsx measure-token-cost.ts -o file.json # Write JSON to file
tsx measure-token-cost.ts --help       # Show help
```

## Optimizing Token Cost

**Reduce description verbosity:**

- Be concise - LLMs don't need hand-holding
- Remove redundant examples
- Focus on unique, non-obvious details

**Simplify parameter schemas:**

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
