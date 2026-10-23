

## Release workflow

A typical CI release creates the release, associates commits, finalizes it, and
records a deploy:

```bash
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
