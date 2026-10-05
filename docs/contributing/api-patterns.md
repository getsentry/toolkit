# API Patterns

Sentry API client usage, mocking, and testing patterns.

## API Client Usage

### Verify Endpoint Contracts

When adding or changing Sentry API endpoint usage in MCP tools, validate the
request parameters and response shape against the Sentry source tree in
`~/src/sentry` before implementing schemas or handlers. Treat API docs,
frontend call sites, and existing MCP types as helpful context, not authority.

Check the relevant Sentry endpoint, serializer, URL registration, and tests.
For example:

```bash
rg -n "class OrganizationAIConversations|ai-conversations" ~/src/sentry/src ~/src/sentry/tests
```

Use the verified source contract to define Zod schemas, query parameters,
pagination behavior, feature-gate handling, and test fixtures.

### Client Creation

```typescript
// Standard usage with context helper
const apiService = apiServiceFromContext(context, {
  regionUrl: params.regionUrl
});

// Direct instantiation
const api = new SentryApiService({
  host: "sentry.io",
  accessToken: token
});
```

See `packages/mcp-server/src/api-utils.ts` and
[adding-tools.md](adding-tools.md#step-2-implement-the-handler) for usage in
tools.

### Common Operations

```typescript
// List with filtering
const issues = await api.issues.list({
  organizationSlug: "org",
  query: "is:unresolved",
  sort: "date"
});

// Get specific resource
const project = await api.projects.get({
  organizationSlug: "org",
  projectIdOrSlug: "frontend"
});

// Create/update
await api.issues.update({
  issueId: "123",
  status: "resolved"
});
```

### Resolved Issue IDs

Use `String(issue.id)` for API requests after resolving an issue. Short IDs can
fail to resolve for legacy mixed-case project slugs; keep them for display.

### Multi-Region Support

Organization discovery uses a single `/api/0/organizations/` request. Public
SaaS hosts use `sentry.io` to list organizations across regions. Single-tenant
hosts under `*.my.sentry.io` and self-hosted instances keep their configured
host for this request.

User identity (`/api/0/auth/`, used by `whoami`) follows the same control-host
routing. Organization-scoped requests continue to use the configured host or
a validated `regionUrl`.

Web links use `<organization>.sentry.io` for public SaaS. Single-tenant and
self-hosted links keep the configured host and `/organizations/<organization>`
path prefix. Use `isPublicSentryHost` for these routing decisions;
`isSentryHost` also recognizes single-tenant deployments and remains the broader
check for HTTPS enforcement and capabilities.

Sentry uses region-specific URLs:

```typescript
// Auto-detect from organization
const orgs = await api.organizations.list();
// Returns: { region_url: "https://us.sentry.io" }

// Use region URL
const api = apiServiceFromContext(context, {
  regionUrl: org.region_url
});
```

## Schema Patterns

### Flexible Sentry Models

```typescript
// Support ID variations
const IssueIdSchema = z.union([
  z.string(),  // "PROJ-123"
  z.number()   // 123456789
]);

// Partial with passthrough for unknowns
const FlexibleSchema = BaseSchema
  .partial()
  .passthrough();

// Nullable handling
z.union([DateSchema, z.null()])
```

See Zod patterns in [common-patterns.md](common-patterns.md#zod-schema-patterns).

### Type Safety

For testing API patterns, see [../testing/overview.md](../testing/overview.md#mock-server-setup).

```typescript
// Derive types from schemas
export type Issue = z.infer<typeof IssueSchema>;

// Runtime validation
const issues = IssueListSchema.parse(response);
```

## Mock Patterns

### MSW Handler Structure

```typescript
export const handlers = [
  {
    method: "get",
    path: "/api/0/organizations/:org/issues/",
    fetch: async ({ request, params }) => {
      // Validate parameters
      if (!params.org) {
        return HttpResponse.json("Invalid org", { status: 400 });
      }
      
      // Return fixture
      return HttpResponse.json(issueListFixture);
    }
  }
];
```

See: `packages/mcp-server-mocks/src/handlers/`

### Request Validation

```typescript
fetch: async ({ request }) => {
  const url = new URL(request.url);
  const query = url.searchParams.get("query");
  
  // Validate query parameters
  if (query && !isValidQuery(query)) {
    return HttpResponse.json("Invalid query", { status: 400 });
  }
  
  // Filter based on query
  const filtered = fixtures.filter(item => 
    matchesQuery(item, query)
  );
  
  return HttpResponse.json(filtered);
}
```

### Dynamic Responses

```typescript
// Support pagination
const limit = parseInt(url.searchParams.get("limit") || "100");
const cursor = url.searchParams.get("cursor");

const start = cursor ? parseInt(cursor) : 0;
const page = fixtures.slice(start, start + limit);

return HttpResponse.json(page, {
  headers: {
    "Link": `<...?cursor=${start + limit}>; rel="next"`
  }
});
```

## Testing with Mocks

### Setup Pattern

```typescript
import { setupMockServer } from "@sentry-mcp/mocks";

const server = setupMockServer();

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
```

### Override Handlers

```typescript
it("handles errors", async () => {
  server.use(
    http.get("*/issues/", () => 
      HttpResponse.json({ error: "Server error" }, { status: 500 })
    )
  );
  
  await expect(api.issues.list(params))
    .rejects.toThrow(ApiError);
});
```

## Error Patterns

### ApiError Handling

```typescript
try {
  const data = await api.issues.list(params);
} catch (error) {
  if (error instanceof ApiError) {
    // Handle specific status codes
    if (error.status === 404) {
      throw new UserInputError("Organization not found");
    }
  }
  throw error;
}
```

See error patterns in [common-patterns.md](common-patterns.md#error-handling).

### Automatic Retries

`SentryApiService.request()` transparently retries transient upstream gateway
failures (`502`/`503`/`504`) using exponential backoff. Retries are:

- **GET-only** — non-idempotent methods (`POST`/`PUT`/`DELETE`) are never
  retried, so an automatic retry can never replay a mutation.
- **Gateway-only** — gated on `ApiServerError.isGatewayError()`. Persistent
  `500`s, `4xx` client errors, and network/configuration errors fail fast.
- **Bypassed by `allowStatuses`** — a status the caller opts into is returned
  as-is from `requestOnce`, never retried.

Callers and tools need no changes: a retried request either resolves normally or
throws the same `ApiServerError` it would have thrown without retries.

## Best Practices

1. **Always use context helper** when in tools/prompts
2. **Handle region URLs** for multi-region support
3. **Validate schemas** at API boundaries
4. **Mock realistically** in tests
5. **Transform errors** for LLM consumption

## References

- API Client: `packages/mcp-server/src/api-client/`
- Mock handlers: `packages/mcp-server-mocks/src/handlers/`
- Fixtures: `packages/mcp-server-mocks/src/fixtures/`
- API Utils: `packages/mcp-server/src/api-utils.ts`
