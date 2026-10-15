# Asset catalog decoder

This executable ports the CoreUI parser from [`getsentry/sentry-cli` at
`c596fcddd616867b6c6cdfa11f9853dc889a585a`](https://github.com/getsentry/sentry-cli/tree/c596fcddd616867b6c6cdfa11f9853dc889a585a/apple-catalog-parsing/native/swift/AssetCatalogParser).
It uses the same Swift reader and Objective-C exception wrapper. The new
entry point loads CoreUI explicitly and calls the reader in a child process.
There is no TypeScript parser for the undocumented `.car` format.

## Build and run

On macOS arm64 with the Xcode command-line tools:

```sh
swift build --configuration release --package-path packages/cli/native/car-extract
packages/cli/native/car-extract/.build/release/car-extract \
  /path/to/App.xcarchive/Products/Applications/App.app/Assets.car \
  /path/to/ParsedAssets
```

The reader always writes `Assets.json` as an array with the legacy `imageId`,
`size`, `name`, `vector`, and optional metadata fields. Decoded images sit next
to the manifest as `<imageId>.<original-extension>`. Colors use the legacy
aggregate row. PDF/SVG hashes, image sets, icons, idioms, scales, and color
spaces follow the legacy reader. Its supported macOS versions are 13, 14, 15,
and 26.

`script/build.ts` compiles and embeds the helper in the macOS arm64 standalone
binary. A failed native build always fails the binary build. Other targets
and the npm package do not ship this helper.
Builds that include `darwin-arm64`, including `build:all`, require a macOS
arm64 host and the Swift toolchain.

At upload time the TypeScript boundary stages catalogs and decoded images on
disk, validates the native manifest and output files, and streams them into
the ZIP. It changes random UUIDs to stable UUID-shaped IDs and renames the
matching image files together. Every metadata field and filename extension
stays compatible with the legacy server contract. The wrapper therefore
stays deterministic across repeated uploads.

Extraction never changes the original archive. A missing helper, unsupported
platform, native crash, timeout, or invalid output leaves the original catalog
in the upload. Native diagnostic output never reaches CLI logs.

## Tests

The macOS CI job builds the standalone binary and runs
`test/lib/build/car-extract.integration.test.ts` with real `.car` fixtures
copied from the legacy repository. It verifies manifests, real image bytes,
node-association filenames, XCArchive and IPA output, repeat-upload stability,
and extraction through the helper embedded in the standalone binary.
