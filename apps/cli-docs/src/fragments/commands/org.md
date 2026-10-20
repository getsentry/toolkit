

## Examples

```bash
# List organizations
sentry org list
```

```
SLUG           NAME                 ROLE
my-org         My Organization      owner
another-org    Another Org          member
```

With several stored accounts (see `sentry auth list`), `sentry org list` lists
the organizations of every logged-in account together, each fetched with that
account's own credentials on its own server, plus an `ACCOUNT` column naming
each account as `<email>:<server>` — the form `--account` and
`sentry auth login` accept. An
organization reachable from several accounts on the same server is listed once,
under the active account if it is one of them, else the most recently used.
Accounts whose login fails are skipped with a warning. `SENTRY_HOST`/`SENTRY_URL` limits the list to accounts on that server,
and `--account` to a single account. The stored active account never changes.
With `--json`, each entry's `account` carries that notation as `selector` and,
already split, as `selectorParts.who` and `selectorParts.server`.

```
$ sentry org list
SLUG             NAME               ACCOUNT
my-org           My Organization    jane@example.com:sentry.io
acme-internal    Acme Internal      jane@acme.com:sentry.acme.com
```

```bash
# Only one account's organizations
sentry org list --account jane@acme.com
# The same email on several servers: add the server
sentry org list -a jane@example.com:sentry.io
```

```bash
# Only organizations whose slug or name matches "acme", best matches first
# (case-insensitive; prefix, substring, and small typos match too)
sentry org list acme
# ...or matches a glob
sentry org list 'acme-*'
```

```bash
# View organization details
sentry org view my-org
```

```
Organization: My Organization
Slug: my-org
Role: owner
Projects: 5
Teams: 3
Members: 12
```

```bash
# Open in browser
sentry org view my-org -w

# JSON output
sentry org list --json
```
