# OAuth Sign-Out Playbook

Reference for diagnosing why users of the remote MCP server (`mcp.sentry.dev`) lose their authenticated session. Covers the token lifecycle, every failure mode we've identified, what each one looks like in telemetry, and the diagnostic path for a specific user complaint.

## Token lifecycle

Upstream: Sentry's OAuth issues a 30-day access token + rotating refresh token on a completed `/oauth/authorize` flow. `ApiToken.expires_at` defaults to `now + 30 days` (see `getsentry/sentry` `src/sentry/models/apitoken.py`).

MCP wrapper: `@cloudflare/workers-oauth-provider` issues its own shorter-lived wrapper access token (default 1h) backed by the same stored grant. Clients refresh against our `/oauth/token`; we do **not** refresh upstream — we reuse the cached upstream access token for its full 30d lifetime. See `tokenExchangeCallback` in `packages/mcp-cloudflare/src/server/oauth/helpers.ts`.

```
MCP client ──(refresh wrapper token)──> /oauth/token ──> tokenExchangeCallback
                                                            │
                                                            ├─ local expires_at in future → cached_valid_local
                                                            ├─ local expired → probe /api/0/auth/ upstream
                                                            │                   ├─ 200 → cached_valid_probed, extend 2h
                                                            │                   ├─ 4xx → upstream_rejected, mark invalid
                                                            │                   └─ 5xx/timeout → verification_indeterminate
                                                            └─ new wrapper access token issued

MCP client ──(tool call)──> /mcp ──> mcp-handler ──> tool handler ──> SentryApiService (upstream /api/0/…)
                                        │                                  │
                                        ├─ upstreamTokenInvalid → revoke   └─ 401 → ServerContext.onUpstreamUnauthorized
                                        └─ rate limit check                   → revoke grant + emit grant_revoked
```

## Failure modes

| Mode                                                                   | Trigger                                              | Currently visible in telemetry                                       | Detected by                                                                                                                               |
| ---------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Natural 30d expiry**                                                 | Upstream `expires_at` passes                         | Yes                                                                  | Probe path in `tokenExchangeCallback` → `upstream_rejected`                                                                               |
| **Premature Sentry-side invalidation (SSO / org / password / admin)**  | Sentry revokes before `expires_at`                   | Yes                                                                  | Tool call surfaces 401 → `app.access.grant.revoked_reason:upstream_rejected_in_use` + grant revoked via `onUpstreamUnauthorized` callback |
| **Stale grants from before `refreshToken` was stored in props**        | Old grants from pre-#537 deploys                     | Yes                                                                  | `mcp-handler` → `app.access.grant.revoked_reason:stale_props_no_refresh`                                                                  |
| **Client-side state loss (DCR state reset, fresh install, reinstall)** | Client drops its stored `client_id`/`refresh_token`  | Indirectly                                                           | High `/oauth/register` volume and `register:callback` ratio per `app.client.family`                                                       |
| **Invalid redirect URI at authorize**                                  | Client sends an `redirect_uri` that's not registered | Yes                                                                  | Log `OAuth authorization failed: Invalid redirect URI` with `clientId`/`redirectUri`/`registeredUris`/`clientName`                        |
| **Upstream probe transient (5xx / rate limit / network)**              | Sentry side instability                              | Yes                                                                  | `app.access.refresh.outcome:verification_indeterminate` with `app.access.probe.reason` (does not force sign-out)                          |
| **Same-user concurrent session interference**                          | Another session of the same user re-authorizes       | Resolved by passing `revokeExistingGrants: false` — see Gap #4 below | n/a after fix                                                                                                                             |

## Telemetry surface

All metrics live in the `mcp-server` project on Sentry. Attribute _keys_ avoid sensitive substrings (`auth`/`oauth`, `token`, `bearer`, `credentials`) via `app.access.*`, and values deliberately avoid those same substrings, because Sentry's default PII scrubber replaces matching keys/values with `[Filtered]` at ingest (see PR #916 and #1219).

### `app.oauth.token_exchange` (counter)

Fired for every `grant_type=refresh_token` request. Splits by `app.access.refresh.outcome`:

- `cached_valid_local` — fast path, local expiry still in future by >2 min
- `cached_valid_probed` — probe confirmed still valid, `accessTokenExpiresAt` extended by 2h
- `upstream_rejected` — probe returned 4xx, grant marked invalid, next `/mcp` request will revoke
- `verification_indeterminate` — probe returned 5xx/429/network error; wrapper falls back to default behavior, grant stays alive

Attributes:

- `app.access.refresh.outcome` — see above
- `app.client.family` — bucketed User-Agent (`claude-code`, `cursor`, `codex`, `copilot`, `claude`, `opencode`, `reactor-netty`, `java-http-client`, `go-http-client`, `python`, `bun`, `node`, `other`, `unknown`)
- `app.access.grant.shape` — currently always `refreshable`
- `app.access.grant.age_bucket` — elapsed time since the MCP grant was created (`lt_1h`, `1h_6h`, `6h_1d`, `1d_7d`, `7d_14d`, `14d_30d`, `gte_30d`, `future`, `unknown`)
- `app.access.upstream.expires_in_bucket` — remaining time before the original upstream Sentry expiry (`expired`, `lt_1h`, `1h_1d`, `1d_7d`, `7d_14d`, `14d_30d`, `gte_30d`, `unknown`)
- `app.access.probe.status_code` — upstream HTTP status on outcomes where a probe fired (`200` / `400` / `401` / `403` / `429` / `500` / …)
- `app.access.probe.reason` — `rate_limit` / `server_error` / `unknown` on `verification_indeterminate`

User context is set from the stored user ID and current request, so metrics can be filtered by `user.id` and events retain the request IP when available. Sub-30d sign-outs surface via `app.oauth.grant_revoked` with `app.access.grant.revoked_reason:upstream_rejected_in_use`, not on this metric.

### `app.oauth.grant_revoked` (counter)

Fired when we revoke a stored grant — either the MCP handler on a subsequent request, or the `onUpstreamUnauthorized` callback on a mid-session 401.

Attributes:

- `app.access.grant.revoked_reason` — `stale_props_no_refresh` / `upstream_rejected` / `upstream_rejected_in_use`
- `app.client.family`
- `app.access.grant.age_bucket`
- `app.access.upstream.expires_in_bucket`
- `user.id` (via Sentry user context)

`upstream_rejected_in_use` indicates Sentry returned 401 to a tool call while the stored access token still looked locally valid — the sub-30d sign-out signal users typically report. The grant is revoked via `env.OAUTH_PROVIDER.revokeGrant` under `ctx.waitUntil`, short-circuiting the death-spiral where subsequent refreshes kept handing out wrapper tokens backed by a dead upstream token.

The handler also emits a low-volume Sentry Log message,
`OAuth grant rejected for reauthorization`, when it decides to force a client
to reauthorize. This log carries the same `app.access.grant.revoked_reason`,
`app.client.family`, `userId`, `clientId`, `app.access.grant.id_hash`,
`app.access.grant.age_bucket`, and
`app.access.upstream.expires_in_bucket`.
Use the hash to correlate one grant/session without logging raw bearer-token
components.

### `app.oauth.callback_completed` (counter)

Fired on a successful `/oauth/callback`. Pairs with `grant_revoked` to derive per-user session lifetime.

Attributes:

- `app.client.family` — resolved from the DCR-registered `client_name` (not the browser User-Agent, which is always a browser string on this endpoint)
- `app.client.registration.method` — `cimd` | `dcr` | `unknown`, classified from the OAuth `client_id` (HTTPS URL => CIMD; opaque id => DCR)
- `user.id`

### `app.oauth.register` (counter)

Fired from the `wrappedOAuthProvider` after the library handles a successful `/oauth/register`.

Attributes:

- `app.client.family` — from the client's User-Agent (accurate here — DCR is hit directly by the MCP client, not via browser)
- `app.client.registration.method` — always `dcr` on this endpoint

### Structured logs

`OAuth authorization failed: Invalid redirect URI` (both GET and POST `/oauth/authorize`) and `Redirect URI not registered for client on callback` now carry `clientId`, `redirectUri`, `registeredUris`, `clientName` as `extra` fields.

`OAuth authorization request rejected: missing redirect URI` identifies GET
`/oauth/authorize` requests with a non-empty `client_id` and a missing or empty
`redirect_uri`. These return a local 400 before client metadata lookup, with no
redirect or Sentry issue. The log carries `code: invalid_request` and
`reason: missing_redirect_uri`, without the authorization URL. Ask the user to
restart authentication in their client and open the full link. Metadata fetch
failures for complete authorization requests still follow the existing error path.

The OAuth provider itself emits high-volume logs shaped like
`OAuth error response: 401 invalid_token - Invalid access token`. Treat those
as the provider-level count source; do not add a second high-volume app log for
the same response. These provider logs currently do not carry `user.id` or
`app.client.family`, so use spans for client attribution and the handler
reauthorization log for per-user/session attribution.

Tracked `/mcp` and direct OAuth endpoint spans/response metrics include:

- `http.response.status_code`
- `http.route`
- `app.route.group`
- `app.client.family` for `/mcp`, `/oauth/token`, and `/oauth/register`
- `app.access.error.code` for OAuth error responses, for example `invalid_access`
- `app.access.error.reason` as a bounded bucket, for example `invalid_access`
- `app.access.request.header_shape` on 401s, for example `missing`, `wrapper`, or `malformed`

## Diagnostic queries

Copy/paste-ready. All use the Sentry MCP's `search_events` natural-language query.

### Is a specific user being revoked?

```
metric app.oauth.grant_revoked filtered by user.id:"<id>" sum of value grouped by app.access.grant.revoked_reason over 30 days
logs message:"OAuth grant rejected for reauthorization" userId:"<id>" grouped by app.access.grant.revoked_reason, app.client.family, app.access.grant.age_bucket, app.access.upstream.expires_in_bucket, clientId, app.access.grant.id_hash over 30 days
```

### Per-client sign-out rate

```
metric app.oauth.grant_revoked sum of value grouped by app.client.family, app.access.grant.revoked_reason over 24 hours
spans /mcp http.response.status_code:401 grouped by app.client.family, app.access.error.code, app.access.request.header_shape over 24 hours
```

### Probe-failure status distribution (is Sentry ever returning 403/400?)

```
metric app.oauth.token_exchange filtered by app.access.refresh.outcome:upstream_rejected sum of value grouped by app.access.probe.status_code over 7 days
metric app.oauth.token_exchange filtered by app.access.refresh.outcome:upstream_rejected sum of value grouped by app.access.grant.age_bucket, app.access.upstream.expires_in_bucket over 7 days
```

### Session-lifetime proxy (callbacks vs revocations per client)

```
metric app.oauth.callback_completed sum of value grouped by app.client.family over 7 days
metric app.oauth.grant_revoked sum of value grouped by app.client.family over 7 days
```

### Register storm attribution

```
metric app.oauth.register sum of value grouped by app.client.family over 7 days
```

### Upstream instability bucket

```
metric app.oauth.token_exchange filtered by app.access.refresh.outcome:verification_indeterminate sum of value grouped by app.access.probe.reason over 24 hours
```

### Invalid redirect URI failures by client

```
logs message:"Invalid redirect URI" over 24 hours, sorted by timestamp
```

## Known gaps

### Gap #1 — Premature Sentry-side invalidation — **closed**

Before: Sentry invalidating a token between issuance and its 30d `expires_at` (SSO session end, password change, admin revoke, org change) only showed up as a 401 on the user's tool call. `handleApiError` wrapped it as `UserInputError`, the grant stayed alive, the next `/oauth/token` refresh took the `cached_valid_local` fast path, and the client got a new wrapper token backed by the same dead upstream token — the death spiral.

After:

- `handleApiError` re-throws `ApiAuthenticationError` unwrapped.
- `server.ts` tool-handler catch detects it (walking `error.cause` up to 3 levels) and invokes `context.onUpstreamUnauthorized`.
- The Cloudflare transport's `onUpstreamUnauthorized` emits `app.oauth.grant_revoked` with `app.access.grant.revoked_reason:upstream_rejected_in_use` and calls `env.OAUTH_PROVIDER.revokeGrant` under `ctx.waitUntil`. `workers-oauth-provider` stores tokens under `token:userId:grantId:*` in KV and validates every access token via a KV lookup, so revoking the grant invalidates all outstanding wrapper tokens too — the client's next `/mcp` request gets a 401 and is forced into a clean re-auth.
- `formatErrorForUser` returns "Authorization Expired — please re-authorize" instead of falling through to the generic Input Error template.

### Gap #2 — `handleApiError` misclassified 401 — **closed**

Fixed alongside Gap #1. `ApiAuthenticationError` now propagates unwrapped and triggers a dedicated branch in `formatErrorForUser`.

### Gap #3 — tool-call `clientInfo` lost on stateless transport

`app.client.name` is `null` on 100% of tool-call spans because `createMcpHandler` (from `agents@0.3.10`) creates a fresh `WorkerTransport` per request, and `clientInfo` is only captured during `initialize`. Closing this would require persisting `clientInfo` keyed by MCP session id (e.g., in `MCP_CACHE` KV) and reinjecting it per-request. Not blocking for OAuth diagnosis — user-agent family is an adequate substitute — but worth fixing for tool-level telemetry.

### Gap #4 — Same-user concurrent session interference — **closed**

`workers-oauth-provider`'s `completeAuthorization` defaulted to revoking every existing grant for `(userId, clientId)` whenever a new authorization completed. Because Claude Code persists its DCR `client_id` across processes (e.g., across project folders, or after an update triggers re-auth in one session), one process re-authorizing would silently invalidate every other active session for the same user. The affected sessions saw 401s from the OAuth library on their next `/mcp` request — _before_ reaching our handler — so no `grant_revoked` metric ever fired. See issue #924.

We now pass `revokeExistingGrants: false` to `completeAuthorization`. Multiple grants for the same `(userId, clientId)` coexist; each lives until its own `refreshTokenTTL` (30d) or an explicit revoke. This matches how mainstream OAuth servers (Google, GitHub, Auth0, etc.) behave; the library's prior default was an unusual policy.

Trade-off: KV storage holds extra grant entries (each up to 30d). Not a real concern at current scale. Library-side auto-revokes are no longer happening, so the cascade event is structurally eliminated rather than counted; if visibility into "user re-authed while another session was active" becomes useful, a metric pre-callback would need its own paginated `listUserGrants` call per callback (skipped here for cost).

## Runbook — "a user says they got signed out"

1. **Check `grant_revoked` for the user** over the relevant window:
   `metric app.oauth.grant_revoked filtered by user.id:"<id>" grouped by app.access.grant.revoked_reason over 30 days`
2. **Interpret the `reason`:**
   - `upstream_rejected_in_use` — Sentry invalidated the token mid-session (SSO / org / password / admin revocation). Most common for sub-30d sign-outs. The grant was revoked automatically; user should re-auth cleanly on next request.
   - `upstream_rejected` — refresh probing got an upstream 4xx. Use `app.access.grant.age_bucket` and `app.access.upstream.expires_in_bucket` to separate near-scheduled expiry from premature upstream rejection.
   - `stale_props_no_refresh` — legacy grant predating PR #537. Expected, one-time.
3. **If no revocations are recorded** (reason counts are empty), the user hasn't been revoked server-side. Either they're still authenticated and the perception is wrong, OR the client lost local state and re-registered without going through `/oauth/callback`:
   - Check `app.oauth.register grouped by app.client.family` for that client — high register:callback ratio (claude-code and cursor re-register on every cold start) is normal client behavior, not a server-side sign-out.
4. **If reporting a specific time**, query `POST /oauth/token` transactions for that `user.id` around that timestamp. Transaction duration and child `GET /api/0/auth/` span tell you whether probes fired.

## Related PRs

- #916 — restored sign-out telemetry (scrubber rename) and reduced probe volume.
- #917 — carried probe status as a metric attribute.
- #918 — added client family, user tagging, `callback_completed` / `register` metrics, probe reason, structured Invalid-redirect-URI fields.
- #919 — added `expired_on_schedule` on `upstream_rejected`. Removed in #920 once we realized the probe path can't produce `"false"` by construction.
- #920 — closes Gaps #1 and #2 via tool-call 401 detection, grant revocation, and `app.access.grant.revoked_reason:upstream_rejected_in_use`. Also removes the unreachable `expired_on_schedule` attribute.
