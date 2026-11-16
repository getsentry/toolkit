# External Issue Linking

`link_issue` and `unlink_issue` manage references between an existing Sentry issue
and an existing external ticket or GitHub pull request. They are catalog-only
tools, discovered through `search_sentry_tools` and called through
`execute_sentry_tool`. Both require the `triage` skill and `event:write` and
`org:read` scopes. No `event:admin` grant is added.

## Interface

```ts
execute_sentry_tool({
  name: "link_issue",
  arguments: {
    organizationSlug: "my-org",
    issueId: "PROJECT-123",
    externalIssueUrl: "https://github.com/example/repo/pull/42",
  },
});
```

Use `unlink_issue` with the same arguments to remove the association. Either
tool accepts `issueUrl` instead of `organizationSlug` and `issueId`, and an
optional `regionUrl`. Session organization, project, and region constraints
still apply. The source issue is resolved before any mutation; subsequent API
calls use its numeric ID.

Native integrations are selected by the URL and installed integration metadata.
An optional `integrationId` disambiguates multiple matching installations. Sentry
receives the complete URL and performs provider-specific parsing and validation
for Jira, GitHub/GitHub Enterprise, GitLab, Bitbucket, and Azure DevOps.

For Sentry Apps, `appSlug` selects the installed App; Linear and Shortcut are
inferred from their URLs. `link_issue` accepts optional `fields` for additional
values required by the App's issue-link form. The client reads the installed
component and resolves its form choices before invoking its link callback.
Missing or ambiguous fields are reported without submitting the callback.
Supported fields are single-value selects, text, and textarea. Other field types
and multi-select fields are reported as unsupported.

## Outcomes and retries

Results contain the Sentry issue ID and URL, the external reference, and a status:

- `linked`: the backend created the association (HTTP 201).
- `already_linked`: the backend returned the existing association (HTTP 200).
- `not_linked`: the association is absent after unlink. This does not claim
  which concurrent request removed it.

App requests include `expectedExternalIssueUrl` as a query parameter. Sentry
compares it exactly with the `webUrl` the App callback returns, after the
callback has run (`IssueLinkCreator._verify_expected_url`). Linear returns its
canonical URL with the current title path, so a bare key URL or another title
path for the same issue gets HTTP 409. Pass the URL exactly as the provider
returns it. An existing equivalent reference uses its stored URL for the guard.

Sentry stores nothing on any of these 409s. When the 409 says a different
external issue would be linked, the client reads the issue's associations once.
If the only association for the App is the requested issue (same workspace and
key), it returns `already_linked` with the stored URL. That only happens when
the App itself or a concurrent request wrote the association (Sentry's
"legacy writers can race the callback"). Another stored URL must be explicitly
unlinked first. With nothing stored, or when the read fails, the error asks for
the issue's current URL from the provider. A 409 for a link operation already
in progress (the backend lock) asks for a retry instead. No unguarded retry or
direct-registration fallback is used. If an App callback returns a conflicting
URL, its external effects cannot be rolled back, even though Sentry rejects the
association. Accepting a bare key or another title path for a new link needs
Sentry to compare App issue identity instead of the exact URL.

Unlink first finds the association by URL, then deletes using its internal Sentry
ID. It never deletes the external ticket or the Sentry issue. Repeating unlink
when no association exists returns `not_linked`.
App deletion is conditional on the association ID, not its URL. A legacy App
writer can replace the URL while retaining that ID between lookup and deletion;
preventing that race would require a conditional-delete API in Sentry.

## Boundaries

GitHub pull requests are external references here. These tools do not create
tickets, link commits, resolve issues, or change assignment. `update_issue`
continues to handle status and assignment separately.

The implementation uses the existing MCP API client, without `@sentry/api`.
It requires the backend's URL linking and guarded App action behavior, including
the HTTP 200/201 contract from getsentry/sentry#124069. Older self-hosted releases
may lack these capabilities; the client does not emulate the missing guarantees.
