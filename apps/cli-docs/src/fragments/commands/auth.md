

## Examples

### OAuth login (recommended)

```bash
sentry auth
```

Bare `sentry auth` logs in when you're logged out and shows status when you're
already authenticated. `sentry auth login` always starts the login flow.

1. A URL and device code will be displayed
2. Open the URL in your browser
3. Enter the code when prompted
4. Authorize the application
5. The CLI stores the OAuth credentials and, when the server provides a refresh
   token, automatically refreshes the access token

### Token login

```bash
sentry auth --token YOUR_SENTRY_API_TOKEN
```

### Read-only OAuth login

Request only read-only scopes — useful for tokens handed to AI agents or
CI jobs that should not mutate Sentry state:

```bash
sentry auth --read-only
```

### Custom OAuth scopes

Request specific scopes (repeatable, comma-separated):

```bash
sentry auth --scope project:read --scope org:read
sentry auth --scope project:read,event:read
```

### Self-hosted Sentry

Use `--url` (recommended) or the `SENTRY_URL` environment variable:

```bash
sentry auth --url https://sentry.example.com
SENTRY_URL=https://sentry.example.com sentry auth
```

For token-based auth with self-hosted:

```bash
sentry auth --token YOUR_TOKEN --url https://sentry.example.com
```

See [Self-Hosted Sentry](../self-hosted/) for details.

### Multiple accounts

The CLI can store several accounts at once — for example a work and a personal
account, or a SaaS and a self-hosted login. When you're already logged in,
`sentry auth login` asks whether to add another account and makes it active;
logging in again as the same user on the same server replaces that account's
credentials instead of adding a duplicate. `--force` skips the prompt and
replaces the stored login for that server instead (or adds one when that
server has none); accounts on other servers are never replaced.

```bash
# Add (or log in again to) a specific account without prompting
sentry auth login jane@example.com
sentry auth login jane@example.com --url https://sentry.example.com

# Show stored accounts; * marks the active one
sentry auth list

# Switch the account commands use (pick from a searchable list without an argument)
sentry auth switch jane@example.com
sentry auth switch
```

Sentry approves a device-flow login as whoever is signed in to the browser, so
`sentry auth login <email>` checks the approved account and refuses (saving
nothing) if it belongs to someone else.

Select an account by email, username, user ID, or account ID (from
`sentry auth list --json`). `sentry auth switch` also accepts a close match —
`sentry auth switch jane` picks `jane@example.com` with a warning when it's the
only candidate. If the same email is stored on several servers, add `--url`:
`sentry auth switch jane@example.com --url https://sentry.example.com`.

Most of the time you don't need to switch: commands pick the stored account
that fits what they target, without changing the active account:

- **Organization** — when the target organization isn't in the active
  account's organization list (cached at login and by `sentry org list`) but
  another stored account has used it, that account is used. This includes
  `oNNNN` IDs from DSNs.
- **Server** — `SENTRY_HOST`/`SENTRY_URL`, `.sentryclirc`, or a pasted Sentry
  URL for another account's server (for example a self-hosted issue link) uses
  the account stored for that server.

```bash
# Active account is personal; this uses the work account that knows acme-corp
sentry issue list acme-corp/

# Uses the self-hosted account without switching
sentry issue view https://sentry.example.com/organizations/acme/issues/123/
```

Otherwise the active account is used. One command never mixes accounts; when
several other accounts know the organization, the most recently used wins.
This works even when the active account is logged out: the target can still
pick a stored account that can authenticate.

Switching also points the default URL (`sentry cli defaults url`) at the
account's server. `SENTRY_HOST`/`SENTRY_URL` and `SENTRY_AUTH_TOKEN` (with
`SENTRY_FORCE_ENV_TOKEN=1`) still take precedence over the active account.
Default organization and project settings are shared by all accounts.

### Logout

```bash
# Log out of the active account (the most recently used other account becomes active)
sentry auth logout

# Log out of specific accounts (space- or comma-separated)
sentry auth logout jane@example.com
sentry auth logout jane@example.com,jane@personal.dev

# Pick the account on one server when the same email is stored twice
sentry auth logout jane@example.com --url https://sentry.example.com

# Log out of every stored account
sentry auth logout all
```

### Refresh the OAuth access token

```bash
sentry auth refresh

# Refresh with read-only scopes
sentry auth refresh --read-only

# Refresh with specific scopes
sentry auth refresh --scope project:read --scope org:read
```

### Print stored token

```bash
sentry auth token
```

### Check auth status

```bash
sentry auth status
```

```
✓ Authenticated
User: username
Access token expires: in 4 weeks
Automatic refresh: enabled
```

```bash
# Show the raw token
sentry auth status --show-token

# View current user
sentry auth whoami
```

## Credential Storage

Auth tokens are stored in the Sentry CLI configuration directory
(`$XDG_CONFIG_HOME/sentry/`, defaulting to `~/.config/sentry/`, overridable
with `SENTRY_CONFIG_DIR`) with restricted file permissions. A pre-existing
legacy `~/.sentry/` directory is still honored.

OAuth access tokens expire. When the server provides a refresh token, the CLI
stores it and refreshes the access token automatically. Persist the
configuration directory across runs to keep automatic refresh working. For
ephemeral CI jobs or sandboxes that cannot persist stored credentials, provide
an API token with `sentry auth login --token` or `SENTRY_AUTH_TOKEN`.

## Token Precedence

By default, the CLI checks for auth tokens in the following order:

1. The stored credential from `sentry auth login`
2. `SENTRY_AUTH_TOKEN` environment variable
3. `SENTRY_TOKEN` environment variable (legacy alias)

The stored credential takes priority. Stored OAuth credentials support
automatic refresh; manually provided API tokens do not use a refresh token. To
override this precedence and force environment tokens to win, set
`SENTRY_FORCE_ENV_TOKEN=1`.

When a token comes from an environment variable, the CLI skips expiry checks and automatic refresh.

## Invalid Token Formatting

Tokens must be a single line of printable ASCII characters, without spaces.
When preparing an access token for storage or an authenticated request, the CLI
removes surrounding whitespace and ASCII control characters, then rejects any
remaining whitespace, control characters, and non-ASCII characters. It does not
join split lines.

If you see "Invalid authentication token", copy the complete token again into
the configuration that supplies it. For environment tokens, check
`SENTRY_AUTH_TOKEN` (or the legacy `SENTRY_TOKEN`). For stored credentials, run
`sentry auth login` to replace them. A token rejected for formatting exits with
code `12` (`AUTH_INVALID`).
