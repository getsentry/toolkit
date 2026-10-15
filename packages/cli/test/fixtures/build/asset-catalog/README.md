# Legacy asset catalog fixtures

The catalogs come from `getsentry/sentry-cli` commit
`c596fcddd616867b6c6cdfa11f9853dc889a585a`:

- `test.xcarchive/Products/Applications/DemoApp.app/Assets.car`:
  [`apple-catalog-parsing/native/swift/AssetCatalogParser/Tests/AssetCatalogParserTests/Resources/test.xcarchive/Products/Applications/DemoApp.app/Assets.car`](https://github.com/getsentry/sentry-cli/blob/c596fcddd616867b6c6cdfa11f9853dc889a585a/apple-catalog-parsing/native/swift/AssetCatalogParser/Tests/AssetCatalogParserTests/Resources/test.xcarchive/Products/Applications/DemoApp.app/Assets.car).
  Git blob: `e4c003fa8b7df3b76164b0f94d7fe0d0afa68e94` (134,975 bytes).
- `archive.xcarchive/Products/Applications/DemoApp.app/Assets.car`:
  [`tests/integration/_fixtures/build/archive.xcarchive/Products/Applications/DemoApp.app/Assets.car`](https://github.com/getsentry/sentry-cli/blob/c596fcddd616867b6c6cdfa11f9853dc889a585a/tests/integration/_fixtures/build/archive.xcarchive/Products/Applications/DemoApp.app/Assets.car).
  Git blob: `86bbc641ac1676a88265487f6dc00f54b195a2f6` (820,632 bytes).

The archives contain only the real catalogs needed by these tests; the app
binaries, signatures, and provisioning profiles are omitted.
