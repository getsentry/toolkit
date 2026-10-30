---
name: sentry-cli-attribute
version: 0.48.0-dev.0
description: Explore span, log, and metric attributes
requires:
  bins: ["sentry"]
  auth: true
---

# Attribute Commands

Explore span, log, and metric attributes

### `sentry attribute list [<target>] [<filter>]`

List attribute keys for spans, logs, or metrics

**Arguments:**

| Argument | Description |
|----------|-------------|
| `[<target>]` | &lt;org&gt;/ (all projects), &lt;org&gt;/&lt;project&gt;, or &lt;project&gt; (search) |
| `[<filter>]` | Text in attribute names and/or has:&lt;key&gt; terms, e.g. 'gen_ai has:http.method' |

**Flags:**
- `-d, --dataset <value> - Dataset to list attributes for (spans, logs, metrics) - (default: "spans")`
- `--type <value>... - Only show attributes of these types: string, number, boolean, array. Repeat the flag for each type or pass a comma-separated list (e.g. --type string,number)`
- `-t, --period <value> - Time range: "7d", "2024-01-01..2024-02-01", ">=2024-01-01" - (default: "7d")`
- `-n, --limit <value> - Maximum number of attributes to list - (default: "25")`
- `-f, --fresh - Bypass cache, re-detect projects, and fetch fresh data`
- `-c, --cursor <value> - Navigate pages: "next", "prev", "first" (or raw cursor string)`

**Examples:**

```bash
# List span attribute keys for a project
sentry attribute list my-org/my-project

# List log attribute keys across the whole organization
sentry attribute list my-org/ --dataset logs

# String attributes whose names contain gen_ai (case-sensitive)
sentry attribute list my-org/ gen_ai --type string

# Discover candidates alongside an attribute
sentry attribute list my-org/ has:gen_ai.request.model

# Discover candidates alongside several keys (one quoted argument)
sentry attribute list my-org/ 'has:gen_ai.request.model has:gen_ai.usage.input_tokens'

# Text and has: filters together
sentry attribute list my-org/ 'gen_ai has:http.method'

# Discover candidates using the last 24 hours (includes built-in and virtual keys)
sentry attribute list my-org/ --period 24h

# Show more than the default 25
sentry attribute list my-org/my-project -n 100

# Show the next page of the previous listing (same flags)
sentry attribute list my-org/my-project -n 100 -c next

# Filter spans that have a discovered key
sentry span list my-org/my-project -q 'has:gen_ai.request.model'

# Find a custom numeric attribute by name
sentry attribute list my-org/my-project cart.total --type number

# Show a discovered typed key as a span column
sentry span list my-org/my-project --fields 'tags[cart.total,number]'

# Group a metric by a discovered attribute
sentry explore my-org/ --dataset metrics -m llm.token_usage -F gen_ai.request.model

# Select fields as JSON
sentry attribute list my-org/ --json --fields key,type,source
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
