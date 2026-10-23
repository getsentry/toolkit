

## Context recovery

If auto-detection cannot find a project, authenticated non-interactive runs show
available `org/project` targets and commands to retry the search. Choose the
project that matches your task; the retry keeps your query, period, limit, sort,
and output flags. Navigation keywords such as `--cursor next` become
`--cursor first` because the chosen project may have no saved pagination state;
raw API cursors are preserved. Suggestions are a bounded sample, with
`sentry project list` commands to discover other projects. Showing suggestions
does not save defaults.

## Search syntax

:::caution[Search syntax]
Sentry search uses **implicit AND** — space-separated terms are all required.
**AND/OR operators are not supported** for issue search. Use alternatives:
- `key:[val1,val2]` — in-list syntax (matches val1 OR val2 for one key)
- Run separate queries for different terms
- `*term*` — wildcard matching

Full syntax reference: [Sentry Search Docs](https://docs.sentry.io/concepts/search/)
:::

## Magic selectors

Use `@latest` and `@most_frequent` to target issues without knowing their ID.

## Common mistakes

- **Don't use the issue command name as an issue prefix** — `sentry issue explain issue-1` is parsed as project `issue` + suffix `1`. Use a real project prefix: `sentry issue explain FRONT-1` or a numeric ID: `sentry issue explain 123456789`.
- **Issue short IDs use uppercase prefixes** — `CLI-G`, not `cli-g`. The CLI tolerates lowercase input in most commands, but agents should prefer the canonical form.
- **`org/project` targets use slugs, not numeric IDs** — `sentry issue list my-org/6775615880` fails when `6775615880` is a project ID copied from a URL. Run `sentry project list my-org/` to find the slug (e.g. `frontend`).
- **Prefer auto-detect over guessing slugs** — omit the target when possible; the CLI resolves org/project from DSNs, `.env` files, and your working directory.

## Short IDs and organizations

Full short IDs such as `FRONT-ABC` use your configured organization: `SENTRY_ORG`,
then `.sentryclirc`, then the default set with `sentry cli defaults org`. The lookup
stays within that organization. To select another organization, include it
explicitly, as in `sentry issue view my-org/FRONT-ABC`.

Project aliases such as `f-abc` keep the organization associated with the alias.
Without a configured organization, the CLI uses a matching detected project or
searches your accessible organizations. If the short ID matches in multiple
organizations, specify the organization explicitly.

## JSON output

`--json` returns the issue fields at the top level plus the latest event under
`event`, the resolved `org` slug, related `replayIds`, and `trace` context.
Prefer this over the human output when parsing programmatically. One issue ID
still returns a single object; multiple IDs return an array of those objects.

In the `--json` output, the latest event's data lives under
`event.entries[]`, each tagged with a `type` (`"exception"`, `"request"`,
`"breadcrumbs"`, …) and a `data` payload — not as top-level `event.request` /
`event.exception` keys.

With `--json`, one explained issue preserves the existing array of root causes.
Multiple issues return an array of labeled objects containing `issue`, `org`,
`issueId`, and `rootCauses`.

## Seer AI plans

`sentry issue plan` generates a fix plan and runs root cause analysis first if
needed.

**Requirements:**

- Seer AI enabled for your organization
- GitHub integration configured with repository access
- Code mappings set up to link stack frames to source files
- Root cause analysis is run automatically if needed (the `plan` command triggers `explain` first)

## Resolving in a release

:::note[How `@commit` auto-detects]
`--in @commit` reads `HEAD` and the `origin` remote, parses the remote as
`owner/repo`, then looks it up in your org's Sentry repositories (cached
locally for 7 days). If any step fails, the command stops with a clear
error pointing you at `--in @commit:<repo>@<sha>` or `sentry repo list <org>/`
— no silent fallback to a different resolution mode.
:::

## Merging issues

Consolidate multiple issues (e.g. same logical error split by Sentry's
default stack-trace grouping) into a single canonical group with
`sentry issue merge`. Without `--into`, Sentry picks the parent (typically
the largest by event count).

All merged issues must share an organization; cross-org merges are rejected.
Non-error issue types (performance, info, etc.) cannot be merged.

## Archiving issues

Archive an issue to suppress alerts. Without `--until`, the issue is archived
forever. Use `--until` to set a condition for automatic unarchival.

:::tip[`--until` syntax reference]
| Format | Meaning |
|--------|---------|
| `auto` | Unarchive on event frequency spike (recommended) |
| `30m`, `1h`, `7d`, `1w` | Duration (minutes, hours, days, weeks) |
| `2026-05-15` | Absolute date (computed as time delta) |
| `10x` or `10events` | After 10 more events |
| `10u` or `10users` | After 10 more users affected |
| `10x/5m` | 10 events within 5 minutes |
| `10users/2hours` | 10 users within 2 hours |
| *(omitted)* | Archive forever |
:::

## Linking external issues

`sentry issue link` links an existing tracker issue or GitHub pull request to a
Sentry issue.

The matching integration must already be installed in the Sentry organization.
Linking requires a Sentry version with native issue URL resolution and guarded
Sentry App callbacks; older self-hosted versions may require an upgrade.
Native integrations include GitHub, GitHub Enterprise, Jira, Jira Server,
GitLab, Bitbucket, and Azure DevOps. Linear uses its installed Sentry App.
Sentry resolves native issue URLs through the selected integration; the remote
issue must be visible to that installation.
Use `--integration <id>` if more than one native integration matches the URL.
Other Sentry Apps require `--app <slug>` and must expose an issue-link form;
additional required form values can be supplied with `--field name=value`.
For other Apps, an issue select can be supplied by exact ID or label with
`--field`, for example `--app custom --field task_id=123`. Sentry checks
that the app's callback identifies the requested URL before saving the association.

`--dry-run` discovers the integration and prepares the link without submitting a
write. The provider validates the remote issue when the link is submitted.
An existing matching link succeeds with `changed: false`. A Sentry App that
already links this issue to a different resource must be unlinked first.
App callbacks must return the exact supplied URL; use the issue URL copied from
the tracker, including its title suffix. A mismatch fails without saving the link.

GitHub and GitHub Enterprise pull requests are stored as external references.
Their `/pull/NUMBER` and `/issues/NUMBER` URLs identify the same resource for
duplicate detection and unlinking. Linking a PR does not mark it as a fix or
resolve the Sentry issue.

This command does not create a tracker issue or link a commit. Existing
integration status-sync settings continue to apply after linking.

### Link permissions

Linking requires `event:write` and access to the Sentry project. Discovering
Sentry Apps also requires `org:read`. Both scopes are included in the default
OAuth login. If an older OAuth session lacks the
requested scopes, the CLI offers reauthorization after a permission error.
Use `sentry auth login` to request the current default scopes. Environment tokens must
be updated separately.

## Unlinking external issues

`sentry issue unlink` removes an association without deleting either issue.

Use `--yes` for non-interactive execution. `--dry-run` shows whether the link
exists without removing it. If the association is already absent, the command
succeeds with `changed: false`.

Unlink matches the URL against stored associations and sends Sentry's internal
link ID to the existing DELETE endpoint. It does not require fetching the ticket
from the remote tracker, so a deleted remote ticket can still be unlinked.
For a custom Sentry App, select it with `--app <slug>`; unlink does not require
the app to expose a link form. Use `--integration <id>` to disambiguate native
integration links.

### Unlink permissions

Unlink requires **`event:write` and access to the Sentry project**; `event:admin`
is also accepted. The organization's “Let Members Delete Events” setting does
not restrict unlinking on updated Sentry versions.

Granting a token more scopes does not override project-access policy.
