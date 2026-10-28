import { spawnSync } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const packageDirectory = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const tsc = require.resolve("typescript/bin/tsc");
const tarball = process.argv[2] && resolve(process.argv[2]);
const temporary = await mkdtemp(join(tmpdir(), "telemetry-consumer-"));

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: packageDirectory,
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`SDK check failed (${result.status ?? result.signal})`);
  return result;
}

try {
  let consumerDirectory = packageDirectory;
  if (tarball) {
    const listing = command("tar", ["-tzf", tarball], {
      encoding: "utf8",
      stdio: "pipe",
    }).stdout;
    const entries = listing.trim().split(/\r?\n/);
    for (const entry of entries) {
      if (
        !entry.startsWith("package/") ||
        entry.includes("\\") ||
        entry.split("/").includes("..")
      )
        throw new Error(`Unsafe packed path: ${entry}`);
      if (
        entry.endsWith("/") &&
        (entry === "package/" || entry.startsWith("package/dist/"))
      )
        continue;
      if (
        /\.(?:test|spec)\./.test(entry) ||
        !/^package\/(?:package\.json|LICENSE|README\.md|dist\/.+\.(?:js|d\.ts|js\.map))$/.test(
          entry,
        )
      )
        throw new Error(`Unexpected packed file: ${entry}`);
    }
    const extracted = join(temporary, "unpacked");
    await mkdir(extracted);
    command("tar", ["-xzf", tarball, "-C", extracted]);
    const packedDirectory = join(extracted, "package");
    consumerDirectory = join(temporary, "consumer");
    await mkdir(consumerDirectory);
    await cp(
      join(packageDirectory, "tests", "types"),
      join(consumerDirectory, "tests", "types"),
      { recursive: true },
    );
    await cp(
      join(packageDirectory, "examples"),
      join(consumerDirectory, "examples"),
      { recursive: true },
    );
    await writeFile(
      join(consumerDirectory, "package.json"),
      '{"type":"module"}\n',
    );
    const scope = join(consumerDirectory, "node_modules", "@sentry");
    await mkdir(scope, { recursive: true });
    await symlink(packedDirectory, join(scope, "spotlight"), "junction");
    const manifest = JSON.parse(
      await readFile(join(packedDirectory, "package.json"), "utf8"),
    );
    // Only declared dependencies are made available to the extracted package.
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      const target = join(packedDirectory, "node_modules", dependency);
      await mkdir(dirname(target), { recursive: true });
      await symlink(
        join(packageDirectory, "node_modules", dependency),
        target,
        "junction",
      );
    }
    // Node and React are development-only contracts for the consumer examples.
    for (const dependency of ["@types/node", "@types/react", "react"]) {
      const target = join(consumerDirectory, "node_modules", dependency);
      await mkdir(dirname(target), { recursive: true });
      await symlink(
        join(packageDirectory, "node_modules", dependency),
        target,
        "junction",
      );
    }
    for (const entry of ["core", "node"])
      for (const extension of ["js", "d.ts"])
        await access(
          join(packedDirectory, "dist", "sdk", `${entry}.${extension}`),
        );
  }

  // Resolve the public export map and emitted declarations, with no source aliases.
  if (!tarball) {
    for (const entry of ["core", "node"]) {
      for (const extension of ["js", "d.ts"]) {
        try {
          await access(
            join(packageDirectory, "dist", "sdk", `${entry}.${extension}`),
          );
        } catch {
          throw new Error(
            "Build @sentry/spotlight before checking its public package",
          );
        }
      }
    }
  }
  const run = (script, args = []) =>
    command(process.execPath, [script, ...args], { cwd: consumerDirectory });
  run(tsc, ["--project", "tests/types/tsconfig.sdk-core.json"]);
  run(tsc, ["--project", "tests/types/tsconfig.sdk-node.json"]);
  const output = join(
    consumerDirectory === packageDirectory ? temporary : consumerDirectory,
    "output",
  );
  run(tsc, ["--project", "examples/tsconfig.json", "--outDir", output]);
  await writeFile(join(output, "package.json"), '{"type":"module"}\n');
  if (!tarball) {
    const scope = join(output, "node_modules", "@sentry");
    await mkdir(scope, { recursive: true });
    await symlink(packageDirectory, join(scope, "spotlight"), "junction");
  }
  run(join(output, "lifecycle.js"));
  console.log(
    `${tarball ? "Packed" : "Built"} SDK declarations, consumer contracts, and executable examples passed.`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
