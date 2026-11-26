import { spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Exit code of `sentry auth status` without credentials. */
const NOT_AUTHENTICATED_EXIT = 10;

function run(binary, args) {
  const result = spawnSync(binary, args, { encoding: "utf8" });
  if (result.error) {
    throw new Error(`${binary} ${args.join(" ")}: ${result.error.message}`);
  }
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
  };
}

/**
 * Runs a standalone binary the way a new user does, with no credentials.
 * Returns human-readable problems, empty when it works. When
 * `expectedVersion` is set, `--version` must print it.
 */
export function smokeTest(binary, { expectedVersion } = {}) {
  const problems = [];

  const help = run(binary, ["--help"]);
  if (help.status !== 0) {
    problems.push(`--help exited ${help.status}:\n${help.output}`);
  }

  if (expectedVersion) {
    const version = run(binary, ["--version"]);
    if (version.output.trim() !== expectedVersion) {
      problems.push(
        `--version printed ${JSON.stringify(version.output.trim())}, expected ${expectedVersion}`,
      );
    }
  }

  const auth = run(binary, ["auth", "status"]);
  if (
    auth.status !== NOT_AUTHENTICATED_EXIT ||
    !/not authenticated/i.test(auth.output)
  ) {
    problems.push(
      `auth status exited ${auth.status}, expected ${NOT_AUTHENTICATED_EXIT} with "not authenticated":\n${auth.output}`,
    );
  }

  return problems;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const binary = process.env.BINARY;
  if (!binary) {
    throw new Error("BINARY is required");
  }
  // Downloaded workflow artifacts lose the exec bit.
  if (process.platform !== "win32") {
    chmodSync(binary, 0o755);
  }
  const problems = smokeTest(binary, {
    expectedVersion: process.env.EXPECTED_VERSION || undefined,
  });
  for (const problem of problems) {
    console.error(`::error::${problem}`);
  }
  if (problems.length > 0) {
    process.exit(1);
  }
  console.log(`${binary} passed the smoke test`);
}
