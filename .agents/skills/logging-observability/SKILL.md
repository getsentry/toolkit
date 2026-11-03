---
name: logging-observability
description: Review code for correct logging and error handling patterns. Use when reviewing code that handles errors, uses logging functions, or captures exceptions. Enforces the error hierarchy where 4xx errors are never logged to Sentry and 5xx errors always are. Trigger phrases include "review logging", "check error handling", "audit observability", or verify correct use of logIssue vs logError.
---

# Logging & Observability Correctness

Enforce correct logging and error handling patterns in the sentry-mcp codebase. The core principle: **4xx errors (user-correctable) must NEVER create Sentry issues. 5xx errors (system failures) must ALWAYS create Sentry issues.**

## Error Hierarchy

### API Errors (`packages/toolkit-core/src/api-client/errors.ts`)

```
ApiError (base class)
├─ ApiClientError (4xx - user errors, NOT sent to Sentry)
│  ├─ ApiPermissionError (403)
│  ├─ ApiNotFoundError (404)
│  ├─ ApiValidationError (400, 422)
│  ├─ ApiAuthenticationError (401)
│  └─ ApiRateLimitError (429)
└─ ApiServerError (5xx - system errors, SENT to Sentry)
```

**4xx errors (`ApiClientError`)**: User input errors. The user can fix these by correcting their request. These must NEVER create Sentry issues.

**5xx errors (`ApiServerError`)**: System failures. These indicate server-side problems outside user control. These must ALWAYS create Sentry issues.

### Application Errors (`packages/mcp-core/src/internal/errors.ts`)

| Error Type           | Sentry Issue? | Use Case                                                    |
| -------------------- | ------------- | ----------------------------------------------------------- |
| `UserInputError`     | No            | Validation failures the user can fix                        |
| `ConfigurationError` | No            | Missing or invalid configuration                            |
| `LLMProviderError`   | No            | AI provider service unavailable (e.g., region restrictions) |

## Logging Functions (`packages/mcp-core/src/telem/logging.ts`)

| Function     | Creates Sentry Issue? | Use For                                                          |
| ------------ | --------------------- | ---------------------------------------------------------------- |
| `logDebug()` | No                    | Development debugging information                                |
| `logInfo()`  | No                    | Routine operational information                                  |
| `logWarn()`  | No                    | Expected errors (4xx), recoverable conditions                    |
| `logError()` | No                    | Errors that do NOT need alerting                                 |
| `logIssue()` | **Yes**               | System failures (5xx), unexpected errors that need investigation |

### When to Use Each Function

**`logDebug()`**: Use for verbose debugging output that helps trace execution flow. Only visible when LOG_LEVEL=debug.

**`logInfo()`**: Use for routine operational events - tool calls, API requests, cache hits. Normal system behavior.

**`logWarn()`**: Use for expected error conditions - API 4xx responses, validation failures, rate limits. The system handled these gracefully.

**`logError()`**: Use for error conditions that do NOT need a Sentry issue. This logs at error level but does NOT create an issue.

**`logIssue()`**: Use ONLY for errors requiring investigation - 5xx responses, unexpected exceptions, system failures. This creates a Sentry issue with an Event ID.

## Anti-Patterns to Catch

### 1. Logging 4xx Errors with `logIssue()`

```typescript
// WRONG: Creates Sentry noise from user errors
if (error instanceof ApiClientError) {
  logIssue(error); // Creates unnecessary Sentry issue
}

// CORRECT: Log without creating an issue
if (error instanceof ApiClientError) {
  logWarn(error, { loggerScope: ["api", "client-error"] });
}
```

**Why this matters**: 4xx errors are user-correctable. Creating Sentry issues for them generates noise that drowns out real system failures.

### 2. Missing `logIssue()` for 5xx Errors

```typescript
// WRONG: Server errors go undetected
if (error instanceof ApiServerError) {
  logError(error); // No Sentry issue created
  return formatError(error);
}

// CORRECT: Create Sentry issue for system failures
if (error instanceof ApiServerError) {
  const eventId = logIssue(error);
  return formatErrorWithEventId(error, eventId);
}
```

**Why this matters**: 5xx errors indicate system failures. Without Sentry issues, these go undetected and unresolved.

### 3. Using Raw `console.log/warn/error`

```typescript
// WRONG: Bypasses structured logging
console.error("Something went wrong:", error);

// CORRECT: Use structured logging
logError(error, {
  loggerScope: ["my-tool"],
  extra: { context: "additional info" },
});
```

**Why this matters**: Raw console methods bypass Sentry integration, lose structured context, and make debugging harder.

### 4. Catching All Errors Indiscriminately

```typescript
// WRONG: Treats all errors the same
try {
  await apiService.fetchData();
} catch (error) {
  logIssue(error); // Even 404s create issues
}

// CORRECT: Discriminate by error type
try {
  await apiService.fetchData();
} catch (error) {
  if (error instanceof ApiServerError) {
    logIssue(error);
  } else if (error instanceof ApiClientError) {
    logWarn(error, { loggerScope: ["api"] });
  } else {
    logIssue(error); // Unknown errors need investigation
  }
}
```

### 5. Missing Structured Context

```typescript
// WRONG: No context for debugging
logIssue(error);

// CORRECT: Include structured context
logIssue(error, {
  loggerScope: ["tool-name", "operation"],
  contexts: {
    request: { organizationSlug, projectSlug },
  },
  extra: { attemptCount: 3 },
});
```

**Why this matters**: Structured context (`loggerScope`, `extra`, `contexts`) enables filtering and searching in Sentry and log aggregation systems.

### 6. Using `captureException()` Directly

```typescript
// WRONG: Bypasses logging wrapper
import { captureException } from "@sentry/core";
captureException(error);

// CORRECT: Use the logging wrapper
logIssue(error, { contexts: { ... } });
```

**Why this matters**: `logIssue()` provides consistent formatting, adds structured context, and logs to both console and Sentry.

## Correct Patterns

### Tool Handler Pattern

Let errors bubble up to the MCP server wrapper. Do NOT catch errors unless adding value.

```typescript
// CORRECT: Let errors bubble naturally
export async function handleTool(params: Params) {
  // API client throws typed errors via createApiError factory
  const result = await apiService.someMethod(params);
  return formatResult(result);
  // Errors bubble to MCP server -> formatErrorForUser handles them
}
```

The MCP server wrapper (`formatErrorForUser`) automatically:

- Formats `ApiClientError` as "Input Error" (no Sentry issue)
- Formats `ApiServerError` as "Error" with Event ID (creates Sentry issue)
- Formats `UserInputError` as "Input Error" (no Sentry issue)

### Agent Tool Pattern

Use `agentTool()` wrapper for embedded agent tools. It handles all error cases.

```typescript
import { agentTool } from "../../internal/agents/tools/utils";

export function createMyTool(apiService: SentryApiService) {
  return agentTool({
    description: "Tool description",
    parameters: z.object({ param: z.string() }),
    execute: async (params) => {
      // No error handling needed - agentTool handles it
      const data = await apiService.someMethod(params);
      return formatResult(data);
    },
  });
}
```

The `agentTool()` wrapper automatically:

- Returns `{ result: data }` on success
- Returns `{ error: "Input Error: ..." }` for `UserInputError` and `ApiClientError`
- Returns `{ error: "Server Error: ..." }` with Event ID for `ApiServerError`
- Uses `logWarn()` for 4xx errors (no Sentry issue)
- Uses `logIssue()` for 5xx errors (creates Sentry issue)

### Graceful Degradation with Error Discrimination

When implementing fallback behavior, discriminate errors properly.

```typescript
async function fetchWithFallback() {
  try {
    return await primarySource.fetch();
  } catch (error) {
    if (error instanceof ApiClientError) {
      // 4xx: User error, don't retry or fall back
      throw error;
    }
    if (error instanceof ApiServerError) {
      // 5xx: System error, log and try fallback
      logIssue(error, {
        loggerScope: ["fetch", "primary-failed"],
        extra: { fallbackAttempted: true },
      });
      return await fallbackSource.fetch();
    }
    // Unknown error: Log and rethrow
    logIssue(error, { loggerScope: ["fetch", "unexpected"] });
    throw error;
  }
}
```

### Including Event ID in User-Facing Errors

When system errors reach users, include the Event ID for support reference.

```typescript
if (error instanceof ApiServerError) {
  const eventId = logIssue(error, {
    contexts: { request: { url, method } },
  });
  return {
    error: `Server error. Event ID: ${eventId}. Contact support with this ID.`,
  };
}
```

## Review Checklist

When reviewing code for logging correctness, verify each item:

### Error Classification

- [ ] `ApiClientError` (4xx) uses `logWarn()`, NOT `logIssue()`
- [ ] `ApiServerError` (5xx) uses `logIssue()`, NOT `logWarn()` or `logError()`
- [ ] `UserInputError` uses `logWarn()`, NOT `logIssue()`
- [ ] Unknown/unexpected errors use `logIssue()` for investigation

### Logging Function Usage

- [ ] No raw `console.log/warn/error` calls (use `logDebug/Info/Warn/Error/Issue`)
- [ ] No direct `captureException()` calls (use `logIssue()` wrapper)
- [ ] Appropriate log level for the situation (debug vs info vs warn vs error)

### Structured Context

- [ ] `loggerScope` identifies the component (e.g., `["tool-name", "operation"]`)
- [ ] `contexts` includes request-level info (org, project, resource IDs)
- [ ] `extra` includes debugging details (attempt counts, durations, flags)

### Error Handling Patterns

- [ ] Tool handlers let errors bubble (no unnecessary try/catch)
- [ ] Agent tools use `agentTool()` wrapper
- [ ] Error discrimination happens before logging decisions
- [ ] Event IDs returned to users for 5xx errors

### Common Issues

| Pattern Found                      | Severity | Action                                 |
| ---------------------------------- | -------- | -------------------------------------- |
| `logIssue(ApiClientError)`         | High     | Change to `logWarn()`                  |
| Missing `logIssue(ApiServerError)` | High     | Add `logIssue()` call                  |
| Raw `console.error()`              | Medium   | Change to `logError()` or `logIssue()` |
| `captureException()` directly      | Medium   | Change to `logIssue()`                 |
| Missing `loggerScope`              | Low      | Add component identifier               |
| Missing `contexts`/`extra`         | Low      | Add structured debugging info          |

## Reference Files

- Logging functions: `packages/mcp-core/src/telem/logging.ts`
- Error hierarchy: `packages/toolkit-core/src/api-client/errors.ts`
- Error formatting: `packages/mcp-core/src/internal/error-handling.ts`
- Agent tool wrapper: `packages/mcp-core/src/internal/agents/tools/utils.ts`
- Full error handling guide: `docs/error-handling.md`
