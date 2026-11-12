

## Debug ID injection

`sentry sourcemap inject` is a purely local file operation — it does not make any API calls and does not require authentication. You can run it in CI before authenticating.

Existing debug IDs from JavaScript comments or sourcemaps are preserved. If a
bundler emits an ID without Sentry's runtime registration snippet, `inject`
adds the snippet and adjusts the sourcemap mappings. Bundles that already
register their ID are left unchanged. `sourcemap upload` applies the same
injection by default, unless `--no-rewrite` is passed.
Binary bundles with an existing debug ID in their sourcemap are left unchanged.

## Resolving sourcemap linkage

Use `sentry sourcemap resolve` to debug why `sentry sourcemap upload` may
not find the expected sourcemaps. It is read-only and never modifies files.
For each JavaScript file, it reports whether the companion `.map` was located
(by convention or via a `sourceMappingURL` directive), whether the map is inline
(`data:` URL) or remote, and whether a Sentry debug ID is present.

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
suppress the error.
