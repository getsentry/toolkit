

## Filtering organizations

Pass a filter to `sentry org list` to only list organizations whose slug or
name matches it, best matches first. Matching ignores case and accepts exact
matches, prefixes, substrings, small typos, or a glob such as `'acme-*'`.

## Multiple accounts

With several stored accounts (see `sentry auth list`), `sentry org list` lists
the organizations of every logged-in account together, each fetched with that
account's own credentials on its own server, plus an `ACCOUNT` column naming
each account as `<email>:<server>` — the form `--account` and
`sentry auth login` accept. An
organization reachable from several accounts on the same server is listed once,
under the active account if it is one of them, else the most recently used.
Accounts whose login fails are skipped with a warning. `SENTRY_HOST`/`SENTRY_URL` limits the list to accounts on that server,
and `--account` to a single account. The stored active account never changes.
With `--json`, each entry's `account` carries that notation as `name`, with its
parts alongside: `email` (or `username`) and `server`.

<!-- allow-commands: sample output with the ACCOUNT column -->
```
$ sentry org list
SLUG             NAME               ACCOUNT
my-org           My Organization    jane@example.com:sentry.io
acme-internal    Acme Internal      jane@acme.com:sentry.acme.com
```
