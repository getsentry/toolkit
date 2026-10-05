

## Examples

```bash
# List releases (auto-detect org)
sentry release list

# List releases in a specific org
sentry release list my-org/

# View release details
sentry release view 1.0.0
sentry release view my-org/1.0.0

# Create and finalize a release
sentry release create 1.0.0 --finalize

# Create a release, then finalize separately
sentry release create 1.0.0
sentry release set-commits 1.0.0 --auto
sentry release finalize 1.0.0

# Set commits from local git history
sentry release set-commits 1.0.0 --local

# Create a deploy
sentry release deploy 1.0.0 production
sentry release deploy 1.0.0 staging "Deploy #42"

# Propose a version from git HEAD
sentry release create $(sentry release propose-version)

# List deploys for a release
sentry release deploys 1.0.0
sentry release deploys my-org/1.0.0

# Archive a release (hide it from the default list, but keep it)
sentry release archive 1.0.0
sentry release archive my-org/1.0.0 --dry-run   # Preview without archiving

# Restore a previously archived release
sentry release restore 1.0.0
sentry release restore my-org/1.0.0

# Delete a release
sentry release delete my-org/1.0.0
sentry release delete my-org/1.0.0 --yes        # Skip confirmation
sentry release delete my-org/1.0.0 --dry-run    # Preview without deleting

# Output as JSON
sentry release list --json
sentry release view 1.0.0 --json

# Full release workflow with explicit org
sentry release create my-org/1.0.0 --project my-project
sentry release set-commits my-org/1.0.0 --auto
sentry release finalize my-org/1.0.0
sentry release deploy my-org/1.0.0 production
```

## Important Notes

- **Version matching**: The release version must match the `release` value in your `Sentry.init()` call. If your SDK uses `"1.0.0"`, create the release as `sentry release create org/1.0.0` (version = `1.0.0`), **not** `sentry release create org/myapp/1.0.0`.
- **The `org/` prefix is the org slug**: In `sentry release create sentry/1.0.0`, `sentry` is the org slug and `1.0.0` is the version. The `/` separates org from version — it is not part of the version string.
- **`--auto` needs a git checkout**: The `--auto` flag lists repos from the Sentry API and matches against your local `origin` remote URL. Without a local git repo, use `--local` instead.
- **Default mode tries `--auto` first**: When neither `--auto` nor `--local` is specified, `set-commits` tries auto-discovery first and falls back to local git history if the integration isn't configured.
