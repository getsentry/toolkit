import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { smokeTest } from "./cli-binary-smoke.mjs";

const directory = mkdtempSync(join(tmpdir(), "cli-binary-smoke-"));
after(() => rmSync(directory, { recursive: true, force: true }));

/** A stand-in binary: `case` arms keyed by the first argument. */
function fakeBinary(name, arms) {
  const path = join(directory, name);
  writeFileSync(path, `#!/bin/sh\ncase "$1" in\n${arms}\nesac\n`, {
    mode: 0o755,
  });
  return path;
}

const WORKING = `  --help) echo USAGE ;;
  --version) echo 4.0.0 ;;
  auth) echo "Error: Not authenticated." >&2; exit 10 ;;`;

describe("smokeTest", () => {
  test("passes a binary that works without credentials", () => {
    const binary = fakeBinary("working", WORKING);
    assert.deepEqual(smokeTest(binary, { expectedVersion: "4.0.0" }), []);
  });

  test("reports a binary that cannot start", () => {
    const binary = fakeBinary(
      "broken",
      '  *) echo "Error loading shared library libstdc++.so.6" >&2; exit 127 ;;',
    );
    const problems = smokeTest(binary);
    assert.equal(problems.length, 2);
    assert.match(problems[0], /--help exited 127/);
    assert.match(problems[1], /libstdc\+\+/);
  });

  test("reports a version other than the expected one", () => {
    const binary = fakeBinary("old", WORKING);
    assert.deepEqual(smokeTest(binary, { expectedVersion: "4.0.1" }), [
      '--version printed "4.0.0", expected 4.0.1',
    ]);
  });

  test("reports a binary that claims to be authenticated", () => {
    const binary = fakeBinary(
      "authenticated",
      "  --help) echo USAGE ;;\n  auth) echo Authenticated ;;",
    );
    assert.match(smokeTest(binary)[0], /auth status exited 0/);
  });
});
