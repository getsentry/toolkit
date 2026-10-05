
## Examples

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

## Important Notes

- This is a **drop-in replacement for Symbolicator's `wasm-split` binary** —
  same flags, same behaviour, same output.
- **Only the build id is printed**, as lowercase hex, so it can be captured in
  a shell variable. Pass `--quiet` to print nothing. `--quiet` cannot be
  combined with `--json`.
- A build id the module **already carries is reused**. Rewriting it would
  orphan debug files uploaded against the old one. `--build-id` applies only
  when the module has none.
- The debug companion is a **complete copy** of the module, captured before
  stripping. DWARF offsets are relative to the code section, so a companion
  missing it cannot be symbolicated. Expect it to be about the size of the
  input.
- `--strip-names` takes effect **only alongside `--strip`**.
- `external_debug_info` is written when `--external-dwarf-url` is given, or
  else from the basename of `--debug-out`. A bare filename resolves relative to
  the main wasm file, which is how Emscripten reads it.
- The file is **left untouched when nothing changed** — no new build id, no
  stripping, no `external_debug_info` — so reruns do not disturb build caches.
