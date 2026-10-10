


## Examples

```bash
# Upload code mappings from a JSON file
sentry code-mappings upload mappings.json

# Specify repository explicitly
sentry code-mappings upload mappings.json --repo owner/repo

# Specify repository and default branch
sentry code-mappings upload mappings.json --repo owner/repo --default-branch develop

# Output as JSON
sentry code-mappings upload mappings.json --json
```

## Input Format

The JSON file must contain an array of objects with `stackRoot` and `sourceRoot`:

```json
[
  { "stackRoot": "com/example/module", "sourceRoot": "src/main/java/com/example/module" },
  { "stackRoot": "com/example/other", "sourceRoot": "src/main/java/com/example/other" }
]
```

## Important Notes

- Repository name and default branch are **auto-detected** from git remotes if
  not provided via `--repo` and `--default-branch`.
- Requires an Organization Token with `org:ci` scope.
- Mappings are uploaded in batches of 300 per API request.
