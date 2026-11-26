/**
 * The `@sentry/cli` npm package: the `sentry` package under the v3 name, so
 * `npm install @sentry/cli@latest` gets version 4.
 */

import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const NPM_ALIAS_NAME = "@sentry/cli";

/**
 * Repack a `sentry` npm tarball as `@sentry/cli`, with the same files and the
 * given README. npm names the result `sentry-cli-<version>.tgz`.
 *
 * @param tarball - Tarball from `npm pack` of the `sentry` package
 * @param readme - README that replaces the package's own
 * @param outDir - Directory for the new tarball
 */
export async function packNpmAlias(
  tarball: string,
  readme: string,
  outDir: string,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "sentry-npm-alias-"));
  try {
    execFileSync("tar", ["-xzf", resolve(tarball), "-C", dir]);
    // npm pack always puts the package in package/.
    const packageDir = join(dir, "package");
    const manifestPath = join(packageDir, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
    manifest.name = NPM_ALIAS_NAME;
    manifest.publishConfig = { access: "public" };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await copyFile(readme, join(packageDir, "README.md"));
    execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--pack-destination", resolve(outDir)],
      { cwd: packageDir, stdio: ["ignore", "ignore", "inherit"] },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
