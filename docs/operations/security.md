# Security

Authentication and security patterns for the Sentry MCP server.

## Remote HTTP Auth Model

The default remote HTTP deployment uses two separate authorization layers:

```
MCP Client → MCP OAuth (our server) → Sentry OAuth → Sentry API
```

This is not just "OAuth to Sentry, then proxy requests back." The Cloudflare
deployment issues its own MCP access token to the client, and that token wraps
the upstream Sentry credentials the server needs to make API calls.

There is also an explicit direct-token mode for trusted clients that already
manage an upstream Sentry API token:

```http
Authorization: Sentry-Bearer <sentry_api_token>
```

That mode bypasses MCP OAuth. The token is not stored, exchanged, refreshed, or
pre-validated by the worker; it is passed through as the upstream Sentry API
token for the request.

### Two Distinct Tokens

For OAuth-backed remote sessions, there are two distinct tokens:

1. **Upstream Sentry token**
   - Issued by Sentry's OAuth server
   - Stored inside the MCP grant props
   - Never sent directly to the MCP client
   - Used only by the MCP server when calling Sentry's REST API

2. **Downstream MCP token**
   - Issued by our OAuth provider (`@cloudflare/workers-oauth-provider`)
   - Sent to the MCP client
   - Used to authenticate requests to `/mcp`
   - Carries encrypted props such as the upstream Sentry token, granted skills, and optional org/project constraints

### End-to-End Flow

1. The MCP client registers with our OAuth provider and starts authorization.
2. Our approval UI collects the MCP-side permissions for the session.
3. We redirect the user to Sentry OAuth.
4. Sentry returns an authorization code to our `/oauth/callback`.
5. We exchange that code for a Sentry access token and refresh token.
6. We issue a downstream MCP token to the client and store the upstream Sentry credentials in its encrypted props.
7. On `/mcp` requests, the worker validates the downstream MCP token, reconstructs `ServerContext`, and uses the upstream Sentry token to call Sentry APIs.

## Permission Model

The important design point is that the upstream token and downstream token do
not mean the same thing.

### Upstream Sentry Scopes

When we redirect to Sentry OAuth, we always request the shared Sentry scope set
defined in `packages/mcp-core/src/scopes.ts`:

```text
org:read project:write team:write event:write alerts:write
```

We ask Sentry for this broader shared token because:

1. Sentry OAuth scopes are coarse compared to our MCP capability model.
2. A single upstream token must support every tool that could be enabled for the granted MCP skills.
3. The worker reuses the same upstream token across later MCP token refreshes and MCP requests for that grant.

This token is therefore a server-side capability token for talking to Sentry,
not the final permission boundary presented to the MCP client.

### Downstream MCP Restrictions

The final token returned to the MCP client is more restrictive in practice. It
captures three separate kinds of restriction:

1. **OAuth scope requested by the MCP client**
   - Stored as `scope` on the MCP grant/token props
   - Represents the downstream OAuth grant made to the MCP client
   - Useful as part of the wrapper-token contract even though runtime tool authorization is primarily skill-based today

2. **Granted MCP skills**
   - Stored as `grantedSkills`
   - This is the primary authorization mechanism for tool exposure in `mcp-core`
   - Tools are registered only when their skill set is enabled

3. **Optional resource constraints**
   - Derived from the OAuth `resource` parameter for `/mcp`, `/mcp/:org`, or `/mcp/:org/:project`
   - Stored as `constraintOrganizationSlug` and `constraintProjectSlug`
   - Enforced on every request so a token minted for one scoped MCP URL cannot be reused against a broader path

### What Actually Enforces Access

Today, runtime authorization for remote HTTP sessions is driven primarily by:

- `grantedSkills` for which tools the session can access
- path constraints for which org/project the session can access
- Sentry's own upstream bearer-token checks for whether the user can perform the underlying API operation

`grantedScopes` still exists on tokens for backward compatibility with older
clients, but it is transitional. Skills are the primary authorization model.

Direct `Sentry-Bearer` sessions default to all active skills and can be narrowed
with `skills` or `disable-skills` query parameters. They do not get OAuth
consent-screen skill selection.

## Security Model

The remote deployment intentionally separates trust boundaries:

1. **Client-to-MCP trust boundary**
   - The client only receives an MCP token
   - The client does not receive raw Sentry OAuth credentials

2. **MCP-to-Sentry trust boundary**
   - Only the server uses the upstream Sentry bearer token
   - All Sentry API access happens server-side

3. **Session narrowing**
   - Broad upstream Sentry scopes are narrowed by MCP-side skills and URL constraints
   - A client may hold a valid MCP token but still be unable to access tools or resources outside the granted session shape

4. **Revocation on upstream failure**
   - If Sentry starts rejecting the stored upstream token, the MCP grant is treated as stale
   - Future requests are forced back through re-authorization instead of silently continuing with an invalid wrapper token

## Key Security Properties

1. **Sentry credentials are server-held**: MCP clients never need direct Sentry API tokens.
2. **Authorization is layered**: Sentry scopes, MCP skills, and MCP resource constraints each narrow access differently.
3. **Each session can be path-scoped**: `/mcp/:org` and `/mcp/:org/:project` produce tokens that only work for that scoped MCP URL.
4. **Refresh does not widen access**: MCP refresh reuses the same stored grant props and does not ask Sentry for broader permissions.
5. **Stale or invalid grants fail closed**: missing props, invalid skills, or rejected upstream tokens are revoked or require re-authentication. Already-issued Cloudflare grants with the old `preprod` skill are treated as `inspect`.

For direct `Sentry-Bearer` sessions, the client intentionally provides the raw
Sentry token. The worker still enforces MCP tool exposure and passes URL
constraints into tool context, but token lifetime, refresh, and revocation are
owned by the caller and upstream Sentry API behavior.

## OAuth Architecture

### Key Components

1. **OAuth Provider** (@cloudflare/workers-oauth-provider)
   - Manages client authorization
   - Stores tokens in KV storage
   - Handles state management
   - Sets auth props in ExecutionContext

2. **Client Approval**
   - First-time clients require user approval
   - Approved clients stored in signed cookies
   - Can surface session scope for constrained `/mcp/...` URLs

3. **Token Management**
   - Access tokens encrypted in KV storage
   - MCP refresh reuses cached Sentry access tokens while they remain valid
   - Tokens can be constrained to organization/project paths

## Implementation Patterns

### OAuth Flow Handler

See implementation: `packages/mcp-cloudflare/src/server/oauth/authorize.ts` and `packages/mcp-cloudflare/src/server/oauth/callback.ts`

Key endpoints:

- `/authorize` - Client approval and redirect to Sentry
- `/callback` - Handle Sentry callback, store tokens
- `/approve` - Process user approval

### Security Context

```typescript
interface ServerContext {
  userId?: string;
  userIpAddress?: string;
  clientId: string;
  accessToken: string;
  grantedSkills: Set<Skill>;  // Primary authorization method
  // grantedScopes is deprecated and will be removed Jan 1, 2026
  constraints: Constraints;
  sentryHost: string;
  mcpUrl?: string;
}
```

Context captured in closures during server build and propagated through:

- Tool handlers (via closure capture and direct parameter passing)
- API client initialization
- Error messages (sanitized)

## Security Measures

### SSRF Protection

The MCP server validates `regionUrl` parameters to prevent Server-Side Request Forgery (SSRF) attacks:

```typescript
// Region URL validation rules:
// 1. By default, only the base host itself is allowed as regionUrl
// 2. Additional domains must be in SENTRY_ALLOWED_REGION_DOMAINS allowlist
// 3. Must use HTTPS protocol for security
// 4. Empty/undefined regionUrl means use the base host

// Base host always allowed
validateRegionUrl("https://sentry.io", "sentry.io"); // ✅ Base host match
validateRegionUrl("https://mycompany.com", "mycompany.com"); // ✅ Base host match

// Allowlist domains (sentry.io, us.sentry.io, de.sentry.io)
validateRegionUrl("https://us.sentry.io", "sentry.io"); // ✅ In allowlist
validateRegionUrl("https://de.sentry.io", "mycompany.com"); // ✅ In allowlist
validateRegionUrl("https://sentry.io", "mycompany.com"); // ✅ In allowlist

// Rejected domains
validateRegionUrl("https://evil.com", "sentry.io"); // ❌ Not in allowlist
validateRegionUrl("http://us.sentry.io", "sentry.io"); // ❌ Must use HTTPS
validateRegionUrl("https://eu.sentry.io", "sentry.io"); // ❌ Not in allowlist
validateRegionUrl("https://sub.mycompany.com", "mycompany.com"); // ❌ Not base host or allowlist
```

Implementation: `packages/mcp-server/src/internal/tool-helpers/validate-region-url.ts`

### Prompt Injection Protection

Tools that accept user input are vulnerable to prompt injection attacks. Key mitigations:

1. **Parameter Validation**: All tool inputs validated with Zod schemas
2. **URL Validation**: URLs parsed and validated before use
3. **Region Constraints**: Region URLs restricted to known Sentry domains
4. **No Direct Command Execution**: Tools don't execute user-provided commands

Example protection in tools:

```typescript
// URLs must be valid and from expected domains
if (!issueUrl.includes('sentry.io')) {
  throw new UserInputError("Invalid Sentry URL");
}

// Region URLs validated against base host
const validatedHost = validateRegionUrl(regionUrl, baseHost);
```

### State Parameter Protection

The OAuth `state` is a compact HMAC-signed payload with a 10‑minute expiry:

```typescript
// Payload contains only what's needed on callback
type OAuthState = {
  clientId: string;
  redirectUri: string; // must be a valid URL
  scope: string[];     // from OAuth provider parseAuthRequest
  permissions?: string[]; // user selections from approval
  iat: number;         // issued at (ms)
  exp: number;         // expires at (ms)
};

// Sign: `${hex(hmacSHA256(json))}.${btoa(json)}` using COOKIE_SECRET
const signed = `${signatureHex}.${btoa(JSON.stringify(state))}`;

// On callback: split, verify signature, parse, check exp > Date.now()
```

Implementation: `packages/mcp-cloudflare/src/server/oauth/state.ts`

### Input Validation

All user inputs sanitized:

- HTML content escaped
- URLs validated
- OAuth parameters verified

### Cookie Security

```typescript
// Signed cookie for approved clients
const cookie = await signCookie(
  `approved_clients=${JSON.stringify(approvedClients)}`,
  COOKIE_SECRET
);

// Cookie attributes
"HttpOnly; Secure; SameSite=Lax; Max-Age=2592000" // 30 days
```

## Error Handling

Security-aware error responses:

- No token/secret exposure in errors
- Generic messages for auth failures
- Detailed logging server-side only

```typescript
catch (error) {
  if (error.message.includes("token")) {
    return new Response("Authentication failed", { status: 401 });
  }
  // Log full error server-side
  console.error("OAuth error:", error);
  return new Response("An error occurred", { status: 500 });
}
```

## Multi-Tenant Security

### Organization Isolation

- Tokens may be scoped to organizations or projects via the OAuth `resource` parameter
- Users can switch organizations
- Each organization requires separate approval

### Access Control

```typescript
// Verify organization access
const { organizations } = await apiService.listOrganizations();
if (!organizations.find(org => org.slug === requestedOrg)) {
  throw new UserInputError("No access to organization");
}
```

## Environment Variables

Required for OAuth:

```bash
SENTRY_CLIENT_ID=your_oauth_app_id
SENTRY_CLIENT_SECRET=your_oauth_app_secret  
COOKIE_SECRET=random_32_char_string
```

## CORS Configuration

```typescript
// Allowed origins for OAuth flow
const ALLOWED_ORIGINS = [
  "https://sentry.io",
  "https://*.sentry.io"
];
```

## References

- OAuth implementation: `packages/mcp-cloudflare/src/server/oauth/*`
- Cookie utilities: `packages/mcp-cloudflare/src/server/utils/cookies.ts`
- OAuth Provider: `packages/mcp-cloudflare/src/server/bindings.ts`
- Sentry OAuth docs: <https://docs.sentry.io/api/guides/oauth/>
