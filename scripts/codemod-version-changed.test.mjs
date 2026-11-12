import assert from "node:assert/strict";
import test from "node:test";
import { codemodVersion, versionChanged } from "./codemod-version-changed.mjs";

const manifest = (version) =>
  `schema_version: "1.0"\n\nname: "@getsentry/cli3to4"\nversion: ${version}\n`;

test("reads quoted, unquoted, and commented versions", () => {
  assert.equal(codemodVersion(manifest('"0.1.0"')), "0.1.0");
  assert.equal(codemodVersion(manifest("0.2.0")), "0.2.0");
  assert.equal(codemodVersion(manifest("'1.0.0' # bump me")), "1.0.0");
  assert.equal(codemodVersion('schema_version: "1.0"\n'), null);
});

test("publishes only when the version changes", () => {
  assert.equal(versionChanged(manifest('"0.1.0"'), manifest('"0.1.0"')), false);
  assert.equal(versionChanged(manifest('"0.1.0"'), manifest('"0.2.0"')), true);
});

test("publishes the first version when there is no previous manifest", () => {
  assert.equal(versionChanged(null, manifest('"0.1.0"')), true);
});

test("fails loudly when the manifest has no version", () => {
  assert.throws(() => versionChanged(null, 'name: "x"\n'));
});
