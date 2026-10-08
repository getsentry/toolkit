---
name: sentry-cli-wasm-split
version: 0.48.0-dev.0
description: Add build ids to WebAssembly modules and split out debug data
requires:
  bins: ["sentry"]
  auth: true
---

# Wasm-split Commands

Add build ids to WebAssembly modules and split out debug data

### `sentry wasm-split <input>`

Add build ids to WebAssembly modules and split out debug data

**Flags:**
- `-o, --out <value> - Path to the output wasm file (default: modify input in place)`
- `-d, --debug-out <value> - Path to the output debug wasm file (default: debug data stays in the input)`
- `--strip - Strip the file of debug info`
- `--strip-names - Strip the file of symbol names (only with --strip)`
- `-q, --quiet - Do not print the build id`
- `--build-id <value> - Explicit build id to use, as a UUID`
- `--external-dwarf-url <value> - URL for browsers to fetch the separate DWARF debug symbol file`

**Examples:**

```bash
# Add a build id to a module, in place, and print it
sentry wasm-split app.wasm

# Capture the build id for a later upload
BUILD_ID=$(sentry wasm-split app.wasm)

# Split debug data into a companion and ship a stripped binary
sentry wasm-split app.wasm --debug-out app.debug.wasm --strip

# Also drop function names from the shipped binary
sentry wasm-split app.wasm -d app.debug.wasm --strip --strip-names

# Point browsers at a companion served from a CDN
sentry wasm-split app.wasm -o dist/app.wasm -d dist/app.debug.wasm --strip \
  --external-dwarf-url https://cdn.example.com/debug/app.debug.wasm
```

All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.
