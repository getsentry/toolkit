

## Release workflow

A typical CI release creates the release, associates commits, finalizes it, and
records a deploy. The `sentry release create` examples above show the full
sequence.

## Important Notes

- **Version matching**: The release version must match the `release` value in your `Sentry.init()` call. If your SDK uses `"1.0.0"`, create the release as `sentry release create org/1.0.0` (version = `1.0.0`), **not** `sentry release create org/myapp/1.0.0`.
- **The `org/` prefix is the org slug**: In `sentry release create sentry/1.0.0`, `sentry` is the org slug and `1.0.0` is the version. The `/` separates org from version — it is not part of the version string.
- **`--auto` needs a git checkout or CI variables**: The `--auto` flag lists repos from the Sentry API and matches against your local `origin` remote URL. Without one (for example, Docker builds that exclude `.git`), it uses the repository and commit from the CI provider: GitHub Actions, GitLab CI, Bitbucket Pipelines, Vercel production builds, Render, Railway, CircleCI, Buildkite, Netlify, and Azure Pipelines. Otherwise, pass `--commit owner/repo@<sha>`.
- **Commits need a repository in Sentry**: `--auto` and `--commit` only work for repositories that a source code integration (GitHub, GitLab, Bitbucket, Azure DevOps) added to your Sentry org. `--commit` takes the name that `sentry repo list` shows. When a name only differs from Sentry's (for example in case), the CLI uses Sentry's name and prints a warning. If your org has no repositories, connect an integration in Sentry under **Settings → Integrations**; the CLI cannot install integrations yet. Until then, `--local` reads commits from local git history.
- **Default mode tries `--auto` first**: When neither `--auto` nor `--local` is specified, `set-commits` tries auto-discovery first and falls back to local git history if the integration isn't configured.
