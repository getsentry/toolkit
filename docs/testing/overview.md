# Testing

Testing strategies and patterns for the Sentry MCP server.

## Testing Philosophy

Our testing approach prioritizes **functional coverage** over implementation details:

### Core Principles

1. **Favor Integration Over Unit Tests**
   - Tests should verify actual functionality, not implementation details
   - Focus on "does this feature work?" rather than "does this internal method work?"
   - Prefer testing through public APIs rather than testing internals directly

2. **Minimize Mocking**
   - **Only mock external network APIs** (Sentry API, OpenAI, etc.) using MSW
   - **Don't mock internal code** - use real implementations
   - **Don't test third-party library behavior** - trust that Node.js, npm packages, etc. work correctly
   - Example: Don't test that Promise.all handles concurrent operations - that's Node.js's job

3. **Test What Matters**
   - Test the functionality users/integrators interact with
   - Test edge cases that could cause real problems
   - Don't test obvious behavior or standard library functionality
   - Don't test that dependencies work as documented

4. **Keep Tests Focused**
   - Each test should verify one clear functional behavior
   - Avoid testing multiple unrelated things in one test
   - Remove tests that don't catch meaningful bugs

### What to Test

✅ **DO test:**
- Tool functionality: "Does find_issues return correct data?"
- API integration: "Does our client handle API errors correctly?"
- Error handling: "Do we provide helpful error messages?"
- Edge cases: "What happens with empty results, special characters, etc.?"
- Configuration: "Can the server be configured for different deployment modes?"

❌ **DON'T test:**
- Standard library behavior (Promise.all, Array.map, etc.)
- Third-party package internals (Zod validation, MSW mocking, etc.)
- Implementation details (private methods, internal state)
- Agent/system prompt text or prompt wording (assert behavior via tool inputs/outputs and Sentry API requests instead)
- Obvious behavior that will break immediately if wrong

### Example: Context Passing

**Bad approach** (testing language features):
```typescript
// ❌ Don't test that closures capture variables
it("closures capture context", async () => {
  const context = { value: 42 };
  const fn = () => context;
  expect(fn().value).toBe(42);
});
```

**Good approach** (testing our functionality):
```typescript
// ✅ Test that server configuration works
it("builds server with context for tool handlers", async () => {
  const server = buildServer({ context });
  expect(server).toBeDefined();
});
```

## Testing Levels

### 1. Functional Tests
Fast, focused tests of actual functionality:
- Located alongside source files (`*.test.ts`)
- Use Vitest with inline snapshots
- Mock external APIs only (Sentry API, OpenAI) with MSW
- Use real implementations for internal code
- Test through public APIs rather than implementation details
- For tools, include at least one happy-path test that snapshots the full
  formatted handler response with `toMatchInlineSnapshot()`. Supplemental
  `toContain()` assertions are fine, but they do not replace a full-response
  snapshot.
- For catalog-only tools, include server-level coverage that executes the tool
  through `execute_sentry_tool` when the change affects discovery, generated
  schemas, constraint injection, or dispatch. Prefer this MSW-backed route for
  mutating tools when live QA would change real Sentry data.
- Review tool output snapshots against
  [../contributing/tool-responses.md](../contributing/tool-responses.md) so
  formatted output stays user-facing and avoids raw internals.

### 2. Evaluation Tests
Real-world scenarios with LLM:
- Located in `packages/mcp-server-evals`
- Use actual AI models
- Verify end-to-end functionality
- Test complete workflows

### 3. Manual Testing
Interactive testing with the MCP test client (preferred for testing MCP changes):

```bash
# Test with local dev server (default: http://localhost:5173)
pnpm -w run cli "who am I?"


# Test against production
pnpm -w run cli --mcp-host=https://mcp.sentry.dev "query"

# Test with local stdio mode (requires SENTRY_ACCESS_TOKEN)
pnpm -w run cli --access-token=TOKEN "query"
```

**When to use manual testing:**
- Verifying end-to-end MCP server behavior
- Testing OAuth flows
- Debugging tool interactions
- Validating real API responses
- Testing AI-powered tools (search_errors/search_traces/search_logs etc., search_issues, search_issue_events)

**Note:** The CLI defaults to `http://localhost:5173` for easier local development. Override with `--mcp-host` or set `MCP_URL` environment variable to test against different servers.

### 4. Real Agent CLI Testing
Use the agent CLI harness when you need to verify behavior through the actual Claude Code or Codex client, not just the MCP test client.

```bash
# Claude Code against the local dev server config

# Codex against the local dev server config

# Claude Code against the checked-in stdio config

# Codex against the checked-in stdio config
```

This harness:
- Uses the real local CLI session for the selected provider
- Checks the configured MCP server entry before running the prompt
- Runs a real authenticated-user smoke prompt and verifies the final response contains an authenticated email

Use `--setup repo --server sentry` to target the hosted server instead of the local `sentry-dev` entry.

Because real clients launch stdio servers non-interactively, first-run device-code auth does not start inside Claude or Codex. Warm that cache from a real TTY first:

```bash
```

When the harness fails, rerun the provider directly with debug enabled so you can inspect the exact MCP startup failure:

```bash
# Claude Code: capture a full debug log for the prompt run
claude --mcp-config /tmp/claude-sentry-dev-config.json --strict-mcp-config --permission-mode bypassPermissions --no-session-persistence --debug-file /tmp/claude-sentry-dev.log -p 'Use the Sentry MCP server named "sentry-dev" to identify the authenticated user. Reply with only the authenticated email address.'

# Codex: capture MCP transport and client debug output
RUST_LOG=codex_core=debug,rmcp=debug RUST_BACKTRACE=1 codex exec --skip-git-repo-check --sandbox read-only --output-last-message /tmp/codex-sentry-dev-last.txt 'Use only the Sentry MCP server named "sentry-dev" to identify the authenticated user. Reply with only the authenticated email address.'
```

For Claude, inspect the debug file for `ToolSearchTool`, `mcp__<server>__search_sentry_tools`, `mcp__<server>__execute_sentry_tool`, MCP connection lines, and any `tool permission denied` entries.
For Codex, inspect the debug output for `UnexpectedContentType`, `AuthRequired`, or `resources/list failed`.

## Functional Testing Patterns

See [../contributing/adding-tools.md](../contributing/adding-tools.md#step-3-add-tests) for the complete tool testing workflow.

### Basic Test Structure

```typescript
describe("tool_name", () => {
  it("returns formatted output", async () => {
    const result = await TOOL_HANDLERS.tool_name(mockContext, {
      organizationSlug: "test-org",
      param: "value"
    });
    
    expect(result).toMatchInlineSnapshot(`
      "# Expected Output
      
      Formatted markdown response"
    `);
  });
});
```

**NOTE**: Follow error handling patterns from [../contributing/error-handling.md](../contributing/error-handling.md) when testing error cases.

### Testing Error Cases

```typescript
it("validates required parameters", async () => {
  await expect(
    TOOL_HANDLERS.tool_name(mockContext, {})
  ).rejects.toThrow(UserInputError);
});

it("handles API errors gracefully", async () => {
  server.use(
    http.get("*/api/0/issues/*", () => 
      HttpResponse.json({ detail: "Not found" }, { status: 404 })
    )
  );
  
  await expect(handler(mockContext, params))
    .rejects.toThrow("Issue not found");
});
```

## Mock Server Setup

See [../contributing/api-patterns.md](../contributing/api-patterns.md) for MSW mock setup, handler patterns, and request validation examples.

## Snapshot Testing

### When to Use Snapshots

Use inline snapshots for:
- Tool output formatting
- Error message text
- Markdown responses
- JSON structure validation

For MCP tools specifically:
- Every tool test suite must include at least one representative successful call
  that snapshots the full handler response.
- Use targeted substring assertions only for additional branch-specific checks,
  not as the only output coverage.
- Snapshot fixtures should include representative upstream internals when the
  formatter is expected to hide or humanize them.
- Add negative assertions for known junk-output risks, such as raw JSON,
  internal component IDs, or empty placeholder values.

### Updating Snapshots

When output changes are intentional:

```bash
cd packages/mcp-server
pnpm vitest --run -u
```

**Always review snapshot changes before committing!** Review them as
user-facing tool output using
[../contributing/tool-responses.md](../contributing/tool-responses.md), not
just as mechanically updated strings.

### Snapshot Best Practices

```typescript
// Good: Inline snapshot for output verification
expect(result).toMatchInlineSnapshot(`
  "# Issues in **my-org**
  
  Found 2 unresolved issues"
`);

// Bad: Don't use snapshots for dynamic data
expect(result.timestamp).toMatchInlineSnapshot(); // ❌
```

## Evaluation Testing

### Eval Test Structure

```typescript
import { describeEval } from "vitest-evals";
import { TaskRunner, Factuality } from "./utils";

describeEval("tool-name", {
  data: async () => [
    {
      input: "Natural language request",
      expected: "Expected response content"
    }
  ],
  task: TaskRunner(),      // Uses AI to call tools
  scorers: [Factuality()], // Validates output
  threshold: 0.6,
  timeout: 30000
});
```

### Running Evals

```bash
# Requires OPENROUTER_API_KEY in .env
pnpm eval

# Run specific eval
pnpm eval tool-name
```

## Test Data Management

### Using Fixtures

```typescript
import { issueFixture } from "@sentry-mcp/mocks";

// Modify fixture for test case
const customIssue = {
  ...issueFixture,
  status: "resolved",
  id: "CUSTOM-123"
};
```

### Dynamic Test Data

```typescript
// Generate test data
function createTestIssues(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    ...issueFixture,
    id: `TEST-${i}`,
    title: `Test Issue ${i}`
  }));
}
```

## Performance Testing

### Timeout Configuration

```typescript
it("handles large datasets", async () => {
  const largeDataset = createTestIssues(1000);
  
  const result = await handler(mockContext, params);
  expect(result).toBeDefined();
}, { timeout: 10000 }); // 10 second timeout
```

### Memory Testing

```typescript
it("streams large responses efficiently", async () => {
  const initialMemory = process.memoryUsage().heapUsed;
  
  await processLargeDataset();
  
  const memoryIncrease = process.memoryUsage().heapUsed - initialMemory;
  expect(memoryIncrease).toBeLessThan(50 * 1024 * 1024); // < 50MB
});
```

## Common Testing Patterns

See [../contributing/common-patterns.md](../contributing/common-patterns.md)
for parameter validation and formatting patterns,
[../contributing/tool-responses.md](../contributing/tool-responses.md) for
tool response policy, [../contributing/error-handling.md](../contributing/error-handling.md)
for error testing, and [../contributing/api-patterns.md](../contributing/api-patterns.md)
for mock setup.

## CI/CD Integration

Tests run automatically on:
- Pull requests
- Main branch commits
- Pre-release checks

Coverage requirements:
- Statements: 80%
- Branches: 75%
- Functions: 80%

## References

- Test setup: `packages/mcp-server/src/test-utils/`
- Mock server: `packages/mcp-server-mocks/`
- Eval tests: `packages/mcp-server-evals/`
- Vitest docs: https://vitest.dev/
