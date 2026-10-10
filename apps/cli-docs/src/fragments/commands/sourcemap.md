

## Examples

### Inject debug IDs

`sentry sourcemap inject` is a purely local file operation — it does not make any API calls and does not require authentication. You can run it in CI before authenticating.

Existing debug IDs from JavaScript comments or sourcemaps are preserved. If a
bundler emits an ID without Sentry's runtime registration snippet, `inject`
adds the snippet and adjusts the sourcemap mappings. Bundles that already
register their ID are left unchanged. `sourcemap upload` applies the same
injection by default, unless `--no-rewrite` is passed.
Binary bundles with an existing debug ID in their sourcemap are left unchanged.

```bash
# Inject debug IDs into all JS files in dist/
sentry sourcemap inject ./dist

# Preview changes without writing
sentry sourcemap inject ./dist --dry-run

# Only process specific extensions
sentry sourcemap inject ./build --ext .js,.mjs
```

### Upload sourcemaps

```bash
# Upload sourcemaps from dist/
sentry sourcemap upload ./dist

# Associate with a release
sentry sourcemap upload ./dist --release 1.0.0

# Set a custom URL prefix
sentry sourcemap upload ./dist --url-prefix '~/static/js/'
```

### Resolve sourcemap linkage

```bash
# Report how each JS file's sourcemap resolves and whether a debug ID
# has been injected (read-only — never modifies files)
sentry sourcemap resolve ./dist

# Machine-readable output
sentry sourcemap resolve ./dist --json
```

Use `sentry sourcemap resolve` to debug why `sentry sourcemap upload` may
not find the expected sourcemaps. It reports, for each JavaScript file,
whether the companion `.map` was located (by convention or via a
`sourceMappingURL` directive), whether the map is inline (`data:` URL) or
remote, and whether a Sentry debug ID is present.

## Error handling

Both `sentry sourcemap inject` and `sentry sourcemap upload` exit with an
error if zero JS + sourcemap pairs are discovered in the target
directory. This catches silent bundler misconfigurations — the most
common cause is a bundler that isn't emitting `.map` files:

```
# Vite / Astro: set `vite.build.sourcemap: "hidden"` (Astro 5) or
# `vite.environments.client.build.sourcemap: "hidden"` (Astro 6+).

# webpack: set `devtool: "hidden-source-map"`.

# esbuild: set `sourcemap: true` or `sourcemap: "linked"`.
```

For CI steps that may run against legitimately-empty directories (e.g.,
library-only repos, conditional release skips), pass `--allow-empty` to
suppress the error:

```bash
sentry sourcemap upload ./dist --allow-empty
```
