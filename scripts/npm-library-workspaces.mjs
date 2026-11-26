/**
 * Lists the Craft release workspaces that `merge-jobs.yml` packs.
 *
 * Craft's default artifact provider reads the tarballs from the artifact
 * that `merge-jobs.yml` uploads for the release commit. A workspace that
 * sets its own `artifactProvider`, like the CLI, is built elsewhere. So the
 * packages to pack are the workspaces without one, and publishing another
 * package needs only its `.craft.yml` entry.
 *
 * Writes `matrix={"include":[{"workspace":"packages/http","name":"http"}]}`
 * to `$GITHUB_OUTPUT`, or prints the matrix when that is unset.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { posix } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The matrix of workspaces that use the default artifact provider.
 *
 * @param {string[]} workspaces Concrete workspace paths, from
 *   `craft workspace list`.
 * @param {(workspace: string) => Record<string, unknown>} resolveConfig The
 *   workspace's resolved configuration, from `craft config --workspace`.
 */
export function libraryMatrix(workspaces, resolveConfig) {
  const include = workspaces
    .filter(
      (workspace) => resolveConfig(workspace).artifactProvider === undefined,
    )
    .map((workspace) => ({ workspace, name: posix.basename(workspace) }));
  if (include.length === 0) {
    throw new Error("No Craft workspace uses the default artifact provider");
  }
  return { include };
}

function craftJson(craft, args) {
  return JSON.parse(execFileSync(craft, args, { encoding: "utf8" }));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const craft = process.env.CRAFT_BIN || "craft";
  const matrix = libraryMatrix(
    craftJson(craft, ["workspace", "list"]),
    (workspace) => craftJson(craft, ["config", "--workspace", workspace]),
  );
  const json = JSON.stringify(matrix);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${json}\n`);
  } else {
    process.stdout.write(`${json}\n`);
  }
}
