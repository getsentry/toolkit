

## Output and targets

Each entry shows the project, name, enabled status, creation date, and public
DSN available in Sentry's **Settings → Projects → Client Keys (DSN)**. A missing
creation date is shown as `—` (`null` in JSON). Internal identifiers and private
keys are not included in either output format.

Use `org/` for the whole organization or `org/project` for a specific project.
A bare name lists matching projects across accessible organizations; when no project matches but an
organization does, it lists that organization's DSNs. Add the trailing slash
to select an organization even when a project has the same name.

Omit the target to use the usual project config or DSN auto-detection,
including multiple projects in a monorepo.
`--limit` caps the total number of DSNs on the page, including organization-wide
results. Both organization and project listings support `-c next` and `-c prev`.
When there are more projects than the limit can display, increase `--limit`
as suggested before continuing; no next cursor is offered that would skip keys.
