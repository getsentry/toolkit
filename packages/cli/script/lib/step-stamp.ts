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
 * reads through (their `package.json`, which names the installed version).
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const STAMP_DIR = "src/generated/.stamps";

/** The files a step reads and the files it writes. */
export type StepFiles = {
  inputs: readonly string[];
  outputs: readonly string[];
};

type Stamp = { inputs: string; outputs: string };

/** The contents of `path`, or `undefined` if it does not exist. */
async function readIfExists(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}

/** Hash the paths and contents of `paths`, or `undefined` if one is missing. */
async function digest(paths: readonly string[]): Promise<string | undefined> {
  const contents = await Promise.all(paths.map(readIfExists));
  const hash = createHash("sha256");
  for (const [index, content] of contents.entries()) {
    if (content === undefined) {
      return;
    }
    hash.update(`${paths[index]}\0`).update(content).update("\0");
  }
  return hash.digest("hex");
}

async function readStamp(path: string): Promise<Stamp | undefined> {
  const content = await readIfExists(path);
  try {
    return content && (JSON.parse(content.toString("utf8")) as Stamp);
  } catch {
    // A corrupt stamp only means the step runs again.
    return;
  }
}

/**
 * The `package.json` of package `name` as installed for `from`. As an
 * input it stands for the package: it names the installed version.
 */
export function packageManifest(name: string, from: string): string {
  return createRequire(resolve(from)).resolve(`${name}/package.json`);
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
