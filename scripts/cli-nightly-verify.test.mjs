import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkNightlyManifest } from "./cli-nightly-verify.mjs";

const VERSION = "4.0.0-dev.1795000000";
const FILES = ["sentry-linux-x64.gz", "sentry-linux-x64-musl.gz"];

function manifest({
  version = VERSION,
  source = "https://github.com/getsentry/toolkit",
  titles = FILES,
} = {}) {
  return {
    annotations: { version, "org.opencontainers.image.source": source },
    layers: titles.map((title) => ({
      annotations: { "org.opencontainers.image.title": title },
    })),
  };
}

describe("checkNightlyManifest", () => {
  test("accepts a manifest with one layer per built binary, in any order", () => {
    assert.deepEqual(
      checkNightlyManifest(manifest({ titles: [...FILES].reverse() }), {
        version: VERSION,
        files: FILES,
      }),
      [],
    );
  });

  test("reports a binary missing from the manifest", () => {
    assert.deepEqual(
      checkNightlyManifest(manifest({ titles: ["sentry-linux-x64.gz"] }), {
        version: VERSION,
        files: FILES,
      }),
      [
        "layers are sentry-linux-x64.gz, expected sentry-linux-x64-musl.gz, sentry-linux-x64.gz",
      ],
    );
  });

  test("reports another version or source", () => {
    assert.deepEqual(
      checkNightlyManifest(
        manifest({ version: "4.0.0-dev.1", source: "https://example.com" }),
        { version: VERSION, files: FILES },
      ),
      [
        `version is "4.0.0-dev.1", expected ${VERSION}`,
        'source is "https://example.com", expected https://github.com/getsentry/toolkit',
      ],
    );
  });
});
