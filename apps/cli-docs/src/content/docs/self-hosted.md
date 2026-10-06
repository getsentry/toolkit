---
title: Self-Hosted Sentry
description: Using the Sentry CLI with a self-hosted Sentry instance
---

The CLI works with self-hosted Sentry instances. Set the `SENTRY_HOST` (or `SENTRY_URL`) environment variable to point at your instance:

```bash
export SENTRY_HOST=https://sentry.example.com
```

## Authenticating

### With OAuth (Sentry 26.1.0+)

The OAuth device flow requires **Sentry 26.1.0 or later** and a public OAuth application registered on your instance.

#### 1. Create a Public OAuth Application

1. In your Sentry instance, go to **Settings → Developer Settings → Applications → Create New Application** (or visit `https://sentry.example.com/settings/account/api/applications/`)
2. Select **Public** as the application type
3. Fill in the required fields (name, redirect URL — can be any placeholder URL)
3. Save the application and copy the **Client ID**

#### 2. Log In

Use the `--url` flag to authenticate against your instance (recommended — this registers the host as trusted):

```bash
SENTRY_CLIENT_ID=your-client-id sentry auth login --url https://sentry.example.com
```

Or pass the instance URL via environment variable:

```bash
SENTRY_HOST=https://sentry.example.com SENTRY_CLIENT_ID=your-client-id sentry auth login --url https://sentry.example.com
```

:::tip
You can export both variables in your shell profile so every CLI invocation picks them up:

```bash
export SENTRY_HOST=https://sentry.example.com
export SENTRY_CLIENT_ID=your-client-id
```
:::

:::note
The `--url` flag is the most secure way to authenticate with a new host — it is the only way to register a trust anchor for that host. Without it, the CLI refuses to log in to an instance URL that was picked up from an untrusted channel (e.g. a `.sentryclirc` file), protecting you from credential leaks and OAuth phishing.
:::

### With an API Token

If your instance is on an older version or you prefer not to create an OAuth application, you can use an API token instead:

1. Go to **Settings → Developer Settings → Personal Tokens** in your Sentry instance (or visit `https://sentry.example.com/settings/account/api/auth-tokens/new-token/`)
2. Create a new token with the following scopes:
<!-- GENERATED:START oauth-scopes -->
`project:read`, `project:write`, `project:admin`, `org:read`, `event:read`, `event:write`, `member:read`, `team:read`, `team:write`, `team:admin`, `alerts:read`, `alerts:write`
<!-- GENERATED:END oauth-scopes -->
3. Pass it to the CLI:

```bash
SENTRY_HOST=https://sentry.example.com sentry auth login --token YOUR_TOKEN --url https://sentry.example.com
```

## After Login

Once authenticated, the CLI stores your instance URL — you don't need to set `SENTRY_URL` on every command. All subsequent commands automatically use the correct instance:

```bash
sentry issue list
sentry org list
```

If you pass a self-hosted Sentry URL as a command argument (e.g., an issue or event URL), the CLI detects the instance automatically.

## TLS / Corporate Proxies

If your self-hosted instance sits behind a private CA certificate (common with corporate TLS-intercepting proxies like Zscaler or Netskope), point `NODE_EXTRA_CA_CERTS` at your CA bundle:

```bash
export NODE_EXTRA_CA_CERTS=/path/to/corporate-ca.pem
```

You can also persist this so you don't need the env var on every invocation:

```bash
sentry cli defaults ca-cert /path/to/corporate-ca.pem
```

If your proxy requires custom HTTP headers (e.g. an IAP token), set them with `SENTRY_CUSTOM_HEADERS` or persist them:

```bash
sentry cli defaults headers "X-IAP: token"
```

## Relevant Environment Variables

<!-- GENERATED:START self-hosted-env-vars -->
| Variable | Description |
|----------|-------------|
| `SENTRY_HOST` | Base URL of your Sentry instance (takes precedence over `SENTRY_URL`) |
| `SENTRY_URL` | Alias for `SENTRY_HOST` |
| `SENTRY_CLIENT_ID` | Client ID of your public OAuth application |
| `SENTRY_CUSTOM_HEADERS` | Custom HTTP headers for proxy/IAP (semicolon-separated `Name: Value` pairs) |
| `SENTRY_FORCE_ENV_TOKEN` | Force env token over stored OAuth token |
| `SENTRY_ORG` | Default organization slug |
| `SENTRY_PROJECT` | Default project slug (supports `org/project` format) |
| `NODE_EXTRA_CA_CERTS` | Path to PEM file with additional CA certificates (for corporate proxies) |
<!-- GENERATED:END self-hosted-env-vars -->

See [Configuration](./configuration/) for the full environment variable reference.
