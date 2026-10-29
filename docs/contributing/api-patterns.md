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

### Issue Activity Attribution

`source` identifies the channel or client, such as `mcp:claude`; `user` and
`sentry_app` identify the actor. `commentId` is the reference accepted by the
notes endpoints and can differ from the activity `id`. For comment creation
responses, use `commentId ?? id`. Both `source` and `commentId` may be absent or null.

### Client Creation

```typescript
// Standard usage with context helper
const apiService = apiServiceFromContext(context, {
  regionUrl: params.regionUrl,
});

// Direct instantiation
const api = new SentryApiService({
  host: "sentry.io",
  accessToken: token,
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
  sort: "date",
});

// Get specific resource
const project = await api.projects.get({
  organizationSlug: "org",
  projectIdOrSlug: "frontend",
});

// Create/update
await api.issues.update({
  issueId: "123",
  status: "resolved",
});
```

### Resolved Issue IDs

Use `String(issue.id)` for API requests after resolving an issue. Short IDs can
fail to resolve for legacy mixed-case project slugs; keep them for display.

### Multi-Region Support

Organization discovery uses `/api/0/organizations/`; a limit over 100 follows
bounded pages through Sentry's Link cursors. Organization, team, and project
lists and most issue and event reads use `@sentry/api` operations to build GET
paths and queries. The MCP client still owns the request transport, token
handling, retries, error types, and Zod response validation. Public SaaS
hosts use `sentry.io` to list organizations across regions. Single-tenant
hosts under `*.my.sentry.io` and self-hosted instances keep their configured
host for this request.

User identity (`/api/0/auth/`, used by `whoami`) follows the same control-host
routing. Organization-scoped requests continue to use the configured host or
a validated `regionUrl`.

Region URL checks reject embedded URL credentials. SaaS region hosts also need
HTTPS, the default port, and an explicit entry in the MCP region allowlist;
self-hosted region hosts must match the configured host and port exactly. The
shared `isSaaSTrustOrigin` check never replaces those product-specific rules.

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
  regionUrl: org.region_url,
});
```

## Schema Patterns

### Flexible Sentry Models

```typescript
// Support ID variations
const IssueIdSchema = z.union([
  z.string(), // "PROJ-123"
  z.number(), // 123456789
]);

// Partial with passthrough for unknowns
const FlexibleSchema = BaseSchema.partial().passthrough();

// Nullable handling
z.union([DateSchema, z.null()]);
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
    },
  },
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
  const filtered = fixtures.filter((item) => matchesQuery(item, query));

  return HttpResponse.json(filtered);
};
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
    Link: `<https://sentry.io/api/0/issues/?cursor=${start + limit}>; rel="next"; results="true"; cursor="${start + limit}"`,
  },
});
```

Use `@sentry/api`'s `parseSentryLinkHeader` to read the next cursor. Sentry's
`Link` header reports whether the next page has results; a URL query alone does
not establish that another page exists.

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
      HttpResponse.json({ error: "Server error" }, { status: 500 }),
    ),
  );

  await expect(api.issues.list(params)).rejects.toThrow(ApiError);
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

`ApiError` and its subclasses live in the shared client,
`@sentry/toolkit-core/api-client/errors`, and `SentryApiService` builds them
from `readErrorResponse` in `@sentry/toolkit-core/api-client/response`. The
CLI reads raw error responses with the same helper and maps them to its own
exit-coded `ApiError`. See
[`packages/toolkit-core/README.md`](../../packages/toolkit-core/README.md#api-client).

### Automatic Retries

`SentryApiService` sends every request, including `@sentry/api` operations,
through the shared transport in `@sentry/toolkit-core/api-client/transport`, which
retries failed requests using the shared policy in
`@sentry/toolkit-core/api-client/retry`. `SentryApiService` never retries on top, so
a request is retried by one layer only. This page describes the
behavior; the values live only in code, so read them there instead of copying
them here:

- Which statuses retry, and for which methods: `RETRYABLE_STATUSES` in
  [`retry.ts`](../../packages/toolkit-core/src/api-client/retry.ts). In short, a
  rate-limited request retries for any method, a transient server error only
  for an idempotent one, and other errors never.
- How many retries and how long they may wait: `REQUEST_RETRY_POLICY` in
  [`client.ts`](../../packages/mcp-core/src/api-client/client.ts).

Retries are:

- **Rate-limit aware** — a `429` waits for its `Retry-After` header, or for
  Sentry's `X-Sentry-Rate-Limit-Reset`. Concurrency-limit `429`s and `5xx`
  errors use jittered exponential backoff.
- **Capped** — by retry count, single wait, and total wait. A reset further
  out than the single-wait cap fails at once with an `ApiRateLimitError` whose
  `retryAfterMs` and user message say when to retry.
- **Abortable** — aborting the request's `signal` ends the wait.
- **Network failures retry for idempotent requests** — when `fetch` itself
  fails (DNS, connection refused or reset, socket timeout), only GET, HEAD,
  and OPTIONS retry, since a write may already have reached Sentry.
- **Fail-fast otherwise** — configuration errors (such as a malformed token)
  are not retried.
  A rate-limited tool call returns a **Rate Limited** message with the retry
  time, not an input error.
- **Before `allowStatuses`** — a status the caller opts into is returned
  as-is, after the transport has finished retrying it.

Callers and tools need no changes: a retried request either resolves normally or
throws the same error it would have thrown without retries.

The CLI sends its requests through the shared transport in
`@sentry/toolkit-core/api-client/transport`, configured in
`packages/cli/src/lib/sentry-client.ts`. It follows the same shared rule; only
the caps differ (`RETRY_POLICY`): the hosted MCP keeps its total wait short so
a Workers request isn't held open, while the CLI can wait longer. The CLI also
applies its own per-request timeout, which counts as a network failure.

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
