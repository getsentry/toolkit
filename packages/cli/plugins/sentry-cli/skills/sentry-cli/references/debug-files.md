---
name: sentry-cli-debug-files
version: 0.48.0-dev.0
description: Work with debug information files
requires:
  bins: ["sentry"]
  auth: true
---

# Debug-files Commands

Work with debug information files

### `sentry debug-files check <path>`

Inspect a debug information file

**Examples:**

```bash
# Inspect a debug information file (auto-detects the format)
sentry debug-files check ./libexample.so

# Inspect the DWARF file inside a dSYM
sentry debug-files check MyApp.dSYM/Contents/Resources/DWARF/MyApp

# Output the report as JSON
sentry debug-files check ./app.pdb --json
```

### `sentry debug-files find <id...>`

Locate debug files for given debug identifiers

**Flags:**
- `-t, --type <value>... - Only consider debug files of the given type (repeatable). Default: all`
- `--no-well-known - Do not look for debug files in well-known locations`
- `--no-cwd - Do not look for debug files in the current directory`
- `-p, --path <value>... - Add a directory to search recursively (repeatable)`

**Examples:**

```bash
# Locate debug files for a debug identifier on disk
sentry debug-files find <debug-id>

# Search only for dSYMs, including an extra directory
sentry debug-files find <debug-id> --type dsym --path ./build

# Search only an explicit directory and output JSON
sentry debug-files find <debug-id> --no-cwd --no-well-known -p /symbols --json
```

### `sentry debug-files upload <path...>`

Upload debug information files to Sentry

**Flags:**
- `-t, --type <value>... - Only upload files of this type (repeatable): dsym, elf, pe, pdb, portablepdb, wasm, breakpad, sourcebundle, jvm`
- `--id <value>... - Only upload the object with this debug id (repeatable)`
- `--require-all - Fail if any --id value was not found among scanned files`
- `--no-debug - Do not upload files whose only feature is debug/symbol info`
- `--no-unwind - Do not upload files whose only feature is unwind info`
- `--no-sources - Do not upload files whose only feature is source info`
- `--include-sources - Build and upload a source bundle for each file with debug info`
- `--il2cpp-mapping - Compute and upload Unity IL2CPP line mappings for each scanned file`
- `--derived-data - Also scan Xcode's DerivedData folder (macOS only)`
- `--no-zips - Do not scan inside .zip archives`
- `--no-upload - Scan and print what would be uploaded without uploading`
- `--wait - Wait for server-side processing and report any errors`
- `--wait-for <value> - Wait up to this many seconds for server-side processing`

**Examples:**

```bash
# Upload debug information files (scans directories recursively)
sentry debug-files upload ./build

# Attach a source bundle to each file
sentry debug-files upload ./libexample.so --include-sources

# Scan a .zip archive in place
sentry debug-files upload ./symbols.zip

# Skip .zip archives
sentry debug-files upload ./build --no-zips

# Upload only dSYMs and wait for server-side processing
sentry debug-files upload ./dsyms --type dsym --wait

# Fail unless the requested debug ID is found
sentry debug-files upload ./build --id <debug-id> --require-all

# Unity: upload IL2CPP line mappings
sentry debug-files upload ./build --il2cpp-mapping

# Unity: upload IL2CPP line mappings with referenced C# sources
sentry debug-files upload ./build --il2cpp-mapping --include-sources

# Preview what would be uploaded (no credentials needed)
sentry debug-files upload ./build --no-upload
```

### `sentry debug-files print-sources <path>`

List the source files a debug file references

**Examples:**

```bash
# List the source files a debug file references (and whether they're available)
sentry debug-files print-sources ./libexample.so

# Output the list as JSON
sentry debug-files print-sources ./app.pdb --json
```

### `sentry debug-files bundle-sources <path>`

Bundle a debug file's source files for source context

**Flags:**
- `-o, --output <value> - Output path for the source bundle ZIP (default: <path>.src.zip)`

**Examples:**

```bash
# Bundle a debug file's referenced source files (run on the build machine)
sentry debug-files bundle-sources ./libexample.so

# Write the bundle to a specific path
sentry debug-files bundle-sources ./app.pdb --output ./app.src.zip
```

### `sentry debug-files bundle-jvm <path>`

Create a JVM source bundle for source context

**Flags:**
- `-o, --output <value> - Output directory for the bundle ZIP`
- `-d, --debug-id <value> - Debug ID (UUID) to stamp on the bundle`
- `-e, --exclude <value>... - Additional directory names to exclude (repeatable)`

**Examples:**

```bash
# Bundle JVM sources with a debug ID
sentry debug-files bundle-jvm --output ./out --debug-id <uuid> ./src

# Exclude additional directories
sentry debug-files bundle-jvm --output ./out --debug-id <uuid> --exclude generated --exclude build-tools ./src

# Output as JSON
sentry debug-files bundle-jvm --output ./out --debug-id <uuid> --json ./src
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
