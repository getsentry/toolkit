// @vitest-environment node
import { execFileSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
test("Windows Git checkout preserves byte-counted replay envelopes", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "local-fixture-checkout-"));
  try {
    const fixturePath = "apps/local/fixtures/01-checkout.txt";
    await mkdir(join(sandbox, "apps/local/fixtures"), { recursive: true });
    const expected = await readFile(join(repository, fixturePath));
    await writeFile(join(sandbox, fixturePath), expected);
    try {
      await copyFile(
        join(repository, ".gitattributes"),
        join(sandbox, ".gitattributes"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    execFileSync("git", ["init", "--quiet"], { cwd: sandbox });
    execFileSync("git", ["-c", "core.autocrlf=false", "add", "."], {
      cwd: sandbox,
    });
    const checkout = join(sandbox, "checkout");
    execFileSync(
      "git",
      [
        "-c",
        "core.autocrlf=true",
        "checkout-index",
        "--all",
        `--prefix=${checkout.replaceAll("\\", "/")}/`,
      ],
      { cwd: sandbox },
    );
    const actual = await readFile(join(checkout, fixturePath));
    expect(actual.byteLength).toBe(expected.byteLength);
    expect(Buffer.compare(actual, expected)).toBe(0);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
