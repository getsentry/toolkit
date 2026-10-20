# Common Patterns

Reusable patterns used throughout the Sentry MCP codebase.

## Error Handling

See [error-handling.md](error-handling.md) for the complete error hierarchy, `UserInputError` patterns, and API error wrapping.

## Zod Schema Patterns

### Reusable Parameter Schemas

Define once, use everywhere:

```typescript
export const ParamOrganizationSlug = z
  .string()
  .trim()
  .describe(
    "The organization's slug. You can find a list using the `find_organizations()` tool.",
  );

export const ParamRegionUrl = z
  .string()
  .url()
  .optional()
  .describe("Sentry region URL. If not provided, uses default region.");
```

See: `packages/mcp-core/src/schema.ts`

### Flexible Schema Patterns

```typescript
// Support multiple ID formats
z.union([z.string(), z.number()]);

// Optional with transforms
z.string()
  .optional()
  .transform((val) => val?.trim());

// Partial objects with passthrough
IssueSchema.partial().passthrough();
```

### Type Derivation

```typescript
export type Organization = z.infer<typeof OrganizationSchema>;
export type ToolParams<T> = z.infer<typeof toolDefinitions[T].parameters>;
```

## Response Formatting

Tool descriptions and parameter `.describe()` text are trusted steering surfaces. It is fine for those descriptions to tell the model when to call a tool, which parameters to preserve, or what follow-up behavior is expected.

Tool result text can include light, scoped steering when it helps the assistant present or use the result correctly. MCP clients still treat result text like external data, so keep this steering narrow:

- OK: `Please tell the user the DSN.`
- OK: `**Suggested presentation:** A compact table works well for these aggregate results.`
- OK: `**Dashboard URL:** https://example.sentry.io/issues/`
- Avoid: `IMPORTANT`, `MUST`, `CRITICAL`, `Display these...`, or `# Using this information` in handler output.
- Avoid: instructions that override assistant behavior beyond this result.

For the complete response contract, including what to include, what to omit,
snapshot review expectations, and QA expectations, see
[tool-responses.md](tool-responses.md).

### Markdown Structure

```typescript
let output = `# ${title}\n\n`;

// Handle empty results
if (data.length === 0) {
  output += "No results found.\n";
  return output;
}

// Add data sections
output += "## Section\n";
output += formatData(data);

// Add response notes
output += "\n\n## Response Notes\n\n";
output += "- Please tell the user the project slug.\n";
output += "- Dashboard URL: https://example.sentry.io/issues/\n";
```

### Multi-Content Resources

```typescript
return {
  contents: [
    {
      uri: url.toString(),
      mimeType: "application/json",
      text: JSON.stringify(data, null, 2),
    },
  ],
};
```

## Parameter Validation

### Required Parameters

```typescript
if (!params.requiredParam) {
  throw new UserInputError(
    "Required parameter is missing. Please provide requiredParam.",
  );
}
```

### Multiple Options

```typescript
if (params.issueUrl) {
  // Extract from URL
} else if (params.organizationSlug && params.issueId) {
  // Use direct parameters
} else {
  throw new UserInputError(
    "Either issueUrl or both organizationSlug and issueId must be provided",
  );
}
```

## TypeScript Helpers

### Generic Type Utilities

```typescript
// Extract Zod schema types from records
type ZodifyRecord<T extends Record<string, any>> = {
  [K in keyof T]: z.infer<T[K]>;
};

// Const assertions for literal types
export const TOOL_NAMES = ["tool1", "tool2"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
```

## References

- Error handling: [error-handling.md](error-handling.md)
- API patterns: [api-patterns.md](api-patterns.md)
- Tool responses: [tool-responses.md](tool-responses.md)
- Testing: [../testing/overview.md](../testing/overview.md)
- Quality checks: [quality-checks.md](quality-checks.md)
