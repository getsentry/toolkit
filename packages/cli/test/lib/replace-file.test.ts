/**
 * Tests for replacing a file's contents in place without a partial write.
 */

import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { replaceFile } from "../../src/lib/replace-file.js";

test("replaces the contents, keeps the mode, and leaves no temp file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sentry-replace-file-"));
  const path = join(dir, "app.wasm");
  await writeFile(path, "old");
  await chmod(path, 0o640);

  await replaceFile(path, new Uint8Array([1, 2, 3]));

  expect(await readFile(path)).toEqual(Buffer.from([1, 2, 3]));
  expect(((await stat(path)).mode % 0o1000).toString(8)).toBe("640");
  expect(await readdir(dir)).toEqual(["app.wasm"]);
});
