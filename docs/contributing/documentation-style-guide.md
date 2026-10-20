# Documentation Style Guide

This guide covers documentation for humans and AI agents working on Toolkit's
CLI, MCP server, and shared packages. The examples below use MCP tools; see the
[CLI guide](../cli/README.md) for the CLI documentation source.

## Core Principles

### 1. Assume Intelligence

- Readers understand programming concepts - don't explain basics
- Focus on project-specific patterns and conventions
- Skip obvious steps like "create a file" or "save your changes"

### 2. Optimize for Context Windows

- Keep documents focused on a single topic
- Use code examples instead of verbose explanations
- Every line should provide unique value
- Split large topics across multiple focused docs

### 3. Show, Don't Tell

- Include minimal, focused code examples
- Reference actual implementations: `packages/mcp-core/src/server.ts`
- Use real patterns from the codebase

## Document Structure

### Required Sections

````markdown
# [Feature/Pattern Name]

Brief one-line description of what this covers.

## When to Use

Bullet points describing specific scenarios.

## Implementation Pattern

```typescript
// Minimal example showing the pattern
const example = {
  // Only include what's unique to this project
};
```

## Key Conventions

Project-specific rules that must be followed.

## Common Patterns

Link to reusable patterns: See "Error Handling" in [Common Patterns](common-patterns.md).

## References

- Implementation: `packages/mcp-core/src/[file].ts`
- Tests: `packages/mcp-core/src/[file].test.ts`
- Examples in codebase: [specific function/tool names]
````

## What to Include

### DO Include:

- **Project-specific patterns** - How THIS codebase does things
- **Architecture decisions** - Why things are structured this way
- **Required conventions** - Must-follow rules for consistency
- **Integration points** - How components interact
- **Validation requirements** - What checks must pass

### DON'T Include:

- **General programming concepts** - How to write TypeScript
- **Tool documentation** - How to use pnpm or Vitest
- **Verbose examples** - Keep code samples minimal
- **Redundant content** - Link to other docs instead
- **Step-by-step tutorials** - Prefer concise project-specific procedures

## Code Examples

### Good Example:

```typescript
// Tool parameter pattern used throughout the codebase
export const ParamOrganizationSlug = z
  .string()
  .trim()
  .describe("The organization's slug. Find using `find_organizations()` tool.");
```

### Bad Example:

```typescript
// First, import the required libraries
import { z } from "zod";

// Define a schema for the organization slug parameter
// This schema will validate that the input is a string
// It will also trim whitespace
export const ParamOrganizationSlug = z
  .string() // Ensures the value is a string
  .trim() // Removes whitespace
  .describe("The organization's slug..."); // Adds description
```

## Cross-References

### File References (MANDATORY):

- Use Markdown links for documentation files: `[Common Patterns](common-patterns.md)`
- Use repo-root relative paths in backticks for code files: `packages/mcp-core/src/server.ts`
- Do not use at-prefixed local references; some agents inline the entire target document.
- Prefer clear link text for docs and concrete path mentions for code.

### Section References:

- Refer to sections by name, not anchors: `See "Error Handling" in [Common Patterns](common-patterns.md).`
- If multiple sections share a name, include a short hint: `("Zod Patterns" in [Common Patterns](common-patterns.md))`

### Code References:

- Use concrete paths and identifiers: `packages/mcp-core/src/tools/catalog/search-events.ts:buildQuery`
- Optional line hints for humans: `server.ts:45-52` (agents may ignore)
- Prefer real implementations over fabricated examples

### External Links:

- Keep standard Markdown links for external sites
- Use concise link text; avoid link-only bullets

## Language and Tone

### Use Direct Language:

- ❌ "You might want to consider using..."
- ✅ "Use UserInputError for validation failures"

### Be Specific:

- ❌ "Handle errors appropriately"
- ✅ "Throw UserInputError with a message explaining how to fix it"

### Focus on Requirements:

- ❌ "It's a good practice to run tests"
- ✅ "Run `pnpm test` - all tests must pass"

## Document Length Guidelines

### Context Window Optimization:

- Each document should be consumable in a single context
- Length depends on complexity, not arbitrary limits
- Verbose explanations → concise code examples
- Complex topics → split into focused documents

### Examples:

- **Quality checks**: ~100 lines (simple commands)
- **Adding a tool**: ~300 lines (includes examples)
- **API patterns**: May be longer if examples are valuable
- **Architecture**: Split into overview + detailed sections

## Maintenance

### When Updating Docs:

1. Check for redundancy with other docs
2. Update cross-references if needed
3. Ensure examples still match codebase
4. Keep line count under 400

### Red Flags:

- Verbose prose explaining what code could show
- Repeated content → extract to [Common Patterns](common-patterns.md)
- No code references → add implementation examples
- Generic programming advice → remove it
- Multiple concepts in one doc → split by topic

## Example: Refactoring a Verbose Section

### Before:

```markdown
## Setting Up Your Development Environment

First, make sure you have Node.js installed. You can download it from nodejs.org.
Next, install pnpm globally using npm install -g pnpm. Then clone the repository
using git clone. Navigate to the project directory and run pnpm install to install
all dependencies. Make sure to create your .env file with the required variables.
```

### After:

````markdown
## Environment Setup

Required: Node.js 22.13+, pnpm

```bash
pnpm install
cp .env.example .env  # Add your API keys
```
````

See the [Toolkit documentation index](../README.md) for product-specific setup.

## Readability Checklist

- Uses Markdown links for docs and repo-root relative paths for code
- Short, focused sections with concrete examples
- Minimal prose; prefers code and commands
- Clear preconditions and environment notes
- Error handling and validation rules are explicit

This style guide keeps documentation focused, valuable, and maintainable for
both human contributors and AI agents.
