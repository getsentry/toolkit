/**
 * Skip a Generator Step When Nothing It Reads Has Changed
 *
 * A step that declares its inputs and outputs runs only when the content
 * hash of either differs from the stamp its last run left in
 * `src/generated/.stamps/`. Hashes, not mtimes: a checkout or a CI cache
 * restore resets mtimes without changing content. The output hash catches
 * outputs that something else rewrote since, such as `generate:grammar`
 * run on its own or another branch's pipeline, and missing outputs never
 * match, so `git clean -fdx src/generated` regenerates everything.
 *
 * Inputs are listed by hand. A step only qualifies when that list is short
 * and stable: its own script, the source it reads, and the packages it
 * reads through (their `package.json`, which pins the installed version).
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const STAMP_DIR = "src/generated/.stamps";

/** The files a step reads and the files it writes. */
export type StepFiles = {
  inputs: readonly string[];
  outputs: readonly string[];
};

type Stamp = { inputs: string; outputs: string };

/** Hash the paths and contents of `paths`, or `undefined` if one is missing. */
async function digest(paths: readonly string[]): Promise<string | undefined> {
  const hash = createHash("sha256");
  for (const path of paths) {
    if (!existsSync(path)) {
      return;
    }
    hash
      .update(`${path}\0`)
      .update(await readFile(path))
      .update("\0");
  }
  return hash.digest("hex");
}

async function readStamp(path: string): Promise<Stamp | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Stamp;
  } catch {
    return;
  }
}

/**
 * The `package.json` of the package `specifier` resolves to from `from`.
 * Packages whose `exports` hide their `package.json` are found by walking
 * up from the resolved entry point.
 */
export function packageManifest(specifier: string, from: string): string {
  let dir = dirname(createRequire(resolve(from)).resolve(specifier));
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`No package.json above ${specifier}`);
    }
    dir = parent;
  }
  return join(dir, "package.json");
}

/** Run `step` unless its inputs and outputs match the last run's stamp. */
export async function runUnlessUnchanged(
  name: string,
  files: StepFiles,
  step: () => Promise<void>,
): Promise<void> {
  const stampPath = join(STAMP_DIR, `${name}.json`);
  const inputs = await digest(files.inputs);
  const stamp = await readStamp(stampPath);
  if (
    inputs !== undefined &&
    stamp?.inputs === inputs &&
    stamp.outputs === (await digest(files.outputs))
  ) {
    console.log(`Skipped ${name}: inputs and outputs unchanged`);
    return;
  }

  await step();

  const outputs = await digest(files.outputs);
  if (inputs === undefined || outputs === undefined) {
    await rm(stampPath, { force: true });
    return;
  }
  await mkdir(STAMP_DIR, { recursive: true });
  await writeFile(
    stampPath,
    `${JSON.stringify({ inputs, outputs } satisfies Stamp)}\n`,
  );
}
