import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKER = "sentry-mcp";

function active(deployment) {
  if (
    !deployment ||
    !UUID.test(deployment.id) ||
    deployment.versions?.length !== 1 ||
    deployment.versions[0].percentage !== 100 ||
    !UUID.test(deployment.versions[0].version_id)
  ) {
    throw new Error("Expected a single active Worker version at 100% traffic");
  }
  return { id: deployment.id, version: deployment.versions[0].version_id };
}

export function capturePrevious(deployments, marker) {
  if (
    !Array.isArray(deployments) ||
    !/^toolkit-mcp:\d+:\d+:[0-9a-f]{40}$/.test(marker)
  ) {
    throw new Error("Missing deployment history or run identity");
  }
  return { previous: active(deployments[0]), marker };
}

function stagedVersions(deployment, previousVersion, candidateVersion) {
  if (
    !deployment ||
    !UUID.test(deployment.id) ||
    !UUID.test(previousVersion) ||
    !UUID.test(candidateVersion) ||
    previousVersion === candidateVersion ||
    !Array.isArray(deployment.versions) ||
    deployment.versions.length !== 2 ||
    !deployment.versions.some(
      (version) =>
        version.version_id === previousVersion && version.percentage === 100,
    ) ||
    !deployment.versions.some(
      (version) =>
        version.version_id === candidateVersion && version.percentage === 0,
    )
  ) {
    throw new Error(
      "Candidate stage must contain the previous version at 100% and candidate at 0%",
    );
  }
  return { id: deployment.id };
}

export function verifyStagedCandidate(deployments, journal) {
  if (!Array.isArray(deployments) || !journal?.previous || !journal?.marker) {
    throw new Error("Missing candidate stage or previous-version journal");
  }
  const previous = active(deployments[1]);
  const staged = stagedVersions(
    deployments[0],
    journal.previous.version,
    journal.candidateVersion,
  );
  if (
    previous.id !== journal.previous.id ||
    previous.version !== journal.previous.version ||
    staged.id === previous.id ||
    deployments[0].annotations?.["workers/message"] !==
      `${journal.marker}:stage` ||
    (journal.staged && journal.staged.id !== staged.id)
  ) {
    throw new Error("Candidate stage ownership or prior version changed");
  }
  return { ...journal, staged };
}

export function verifyPromotedCandidate(deployments, journal) {
  if (!Array.isArray(deployments) || !journal?.staged) {
    throw new Error("Missing verified candidate stage");
  }
  const candidate = active(deployments[0]);
  verifyStagedCandidate(deployments.slice(1), journal);
  if (
    candidate.id === journal.staged.id ||
    candidate.version !== journal.candidateVersion ||
    deployments[0].annotations?.["workers/message"] !==
      `${journal.marker}:promote` ||
    (journal.candidate &&
      (journal.candidate.id !== candidate.id ||
        journal.candidate.version !== candidate.version))
  ) {
    throw new Error("Promotion ownership or candidate version changed");
  }
  return { ...journal, candidate };
}

// The workflow_dispatch path has no runner-local journal. It may recover only
// the newest owned deployment, with the staging deployment and its original
// predecessor still adjacent in Cloudflare history.
export function recoverManualSnapshot(deployments, marker) {
  if (
    !Array.isArray(deployments) ||
    !/^toolkit-mcp:\d+:\d+:[0-9a-f]{40}$/.test(marker)
  ) {
    throw new Error("Invalid manual recovery run identity");
  }
  if (deployments[0]?.annotations?.["workers/message"] === `${marker}:stage`) {
    const previous = active(deployments[1]);
    const candidateVersion = deployments[0].versions?.find(
      (version) => version.percentage === 0,
    )?.version_id;
    return verifyStagedCandidate(deployments, {
      marker,
      previous,
      candidateVersion,
    });
  }
  if (
    deployments[0]?.annotations?.["workers/message"] === `${marker}:promote`
  ) {
    const previous = active(deployments[2]);
    const candidateVersion = active(deployments[0]).version;
    const staged = verifyStagedCandidate(deployments.slice(1), {
      marker,
      previous,
      candidateVersion,
    });
    return verifyPromotedCandidate(deployments, staged);
  }
  throw new Error("Latest deployment is not owned by the requested run marker");
}

export function verifyCandidate(deployments, journal) {
  if (!Array.isArray(deployments) || !journal?.previous || !journal.marker) {
    throw new Error("Missing deployment history or previous-version journal");
  }
  const candidate = active(deployments[0]);
  if (
    candidate.id === journal.previous.id ||
    deployments[0].annotations?.["workers/message"] !== journal.marker ||
    deployments[1]?.id !== journal.previous.id ||
    active(deployments[1]).version !== journal.previous.version
  ) {
    throw new Error(
      "Deployment ownership or prior version changed; refusing recovery",
    );
  }
  return { ...journal, candidate };
}

export function assertOwnedCandidate(deployments, journal) {
  if (journal?.staged) {
    if (journal.candidate) {
      verifyPromotedCandidate(deployments, journal);
    } else {
      verifyStagedCandidate(deployments, journal);
    }
    return journal.previous.version;
  }
  const actual = verifyCandidate(deployments, journal);
  if (
    !journal.candidate ||
    actual.candidate.id !== journal.candidate.id ||
    actual.candidate.version !== journal.candidate.version
  ) {
    throw new Error(
      "Production no longer runs this job's candidate; refusing recovery",
    );
  }
  return journal.previous.version;
}

async function listDeployments(env) {
  if (
    !/^[0-9a-f]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID ?? "") ||
    !env.CLOUDFLARE_API_TOKEN
  ) {
    throw new Error("Cloudflare account ID and API token are required");
  }
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${WORKER}/deployments?per_page=3`,
    {
      headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    throw new Error("Cloudflare deployment lookup failed");
  }
  const body = await response.json();
  if (body.success !== true || !Array.isArray(body.result?.deployments)) {
    throw new Error("Cloudflare returned an invalid deployment list");
  }
  return body.result.deployments;
}

function runMarker(env) {
  if (
    !/^[1-9]\d*$/.test(env.SOURCE_RUN_ID ?? env.GITHUB_RUN_ID ?? "") ||
    !/^[1-9]\d*$/.test(
      env.SOURCE_RUN_ATTEMPT ?? env.GITHUB_RUN_ATTEMPT ?? "",
    ) ||
    !/^[0-9a-f]{40}$/.test(env.SOURCE_SHA ?? env.TESTED_SHA ?? "")
  ) {
    throw new Error("Invalid GitHub run identity");
  }
  return `toolkit-mcp:${env.SOURCE_RUN_ID ?? env.GITHUB_RUN_ID}:${env.SOURCE_RUN_ATTEMPT ?? env.GITHUB_RUN_ATTEMPT}:${env.SOURCE_SHA ?? env.TESTED_SHA}`;
}

function runWrangler(args, env, spawn = spawnSync) {
  const child = spawn("pnpm", ["exec", "wrangler", ...args], {
    cwd: join(import.meta.dirname, "../packages/mcp-cloudflare"),
    env,
    stdio: "inherit",
  });
  if (child.error) throw new Error("Wrangler could not start");
  if (child.status !== 0)
    throw new Error("Cloudflare version transition failed");
}

export function parseUploadedVersion(output) {
  if (typeof output !== "string" || output.length > 64_000) {
    throw new Error("Invalid Wrangler upload output");
  }
  const lines = output.trimEnd().split("\n");
  if (lines.length !== 2) throw new Error("Incomplete Wrangler upload output");
  let session;
  let success;
  try {
    [session, success] = lines.map((line) => JSON.parse(line));
  } catch {
    throw new Error("Invalid Wrangler upload output");
  }
  if (
    session?.type !== "wrangler-session" ||
    !Array.isArray(session.command_line_args) ||
    session.command_line_args[0] !== "versions" ||
    session.command_line_args[1] !== "upload" ||
    !session.command_line_args.includes("--experimental-auto-create=false") ||
    success?.type !== "version-upload" ||
    success.worker_name !== WORKER ||
    success.worker_name_overridden !== false ||
    !UUID.test(success.version_id)
  ) {
    throw new Error(
      "Wrangler did not confirm a production Worker version upload",
    );
  }
  return success.version_id;
}

export async function restorePreviousVersion(
  deployments,
  journal,
  env,
  { list = listDeployments, spawn = spawnSync } = {},
) {
  const previous = assertOwnedCandidate(deployments, journal);
  if (!UUID.test(previous)) {
    throw new Error("Invalid captured previous version");
  }
  runWrangler(
    [
      "versions",
      "deploy",
      `${previous}@100`,
      "--yes",
      "--message",
      `Toolkit recovery ${env.GITHUB_RUN_ID}`,
    ],
    env,
    spawn,
  );
  const recovered = active((await list(env))[0]);
  if (recovered.version !== previous || recovered.id === deployments[0].id) {
    throw new Error(
      "Cloudflare did not activate the captured previous version",
    );
  }
}

async function main(command, env) {
  if (
    ![
      "capture",
      "uploaded",
      "stage",
      "promote",
      "verify",
      "recover",
      "manual",
    ].includes(command)
  ) {
    throw new Error("Unknown Cloudflare deployment operation");
  }
  if (!env.RUNNER_TEMP) {
    throw new Error("RUNNER_TEMP is required");
  }
  const path = join(env.RUNNER_TEMP, "mcp-production-deployment.json");
  const deployments = await listDeployments(env);
  if (command === "capture") {
    const journal = capturePrevious(deployments, runMarker(env));
    await writeFile(path, JSON.stringify(journal), { mode: 0o600 });
    return;
  }
  if (command === "manual") {
    const journal = recoverManualSnapshot(deployments, runMarker(env));
    await restorePreviousVersion(deployments, journal, env);
    if (env.GITHUB_OUTPUT) {
      await writeFile(
        env.GITHUB_OUTPUT,
        `previous_version=${journal.previous.version}\n`,
        { flag: "a" },
      );
    }
    return;
  }
  const journal = JSON.parse(await readFile(path, "utf8"));
  if (journal.marker !== runMarker(env)) {
    throw new Error("Deployment journal belongs to another run");
  }
  if (command === "uploaded") {
    const candidateVersion = parseUploadedVersion(
      await readFile(env.WRANGLER_OUTPUT_FILE_PATH, "utf8"),
    );
    const live = active(deployments[0]);
    if (
      live.id !== journal.previous.id ||
      live.version !== journal.previous.version ||
      candidateVersion === live.version
    ) {
      throw new Error("Production changed during candidate upload");
    }
    await writeFile(path, JSON.stringify({ ...journal, candidateVersion }), {
      mode: 0o600,
    });
    if (env.GITHUB_OUTPUT) {
      await writeFile(
        env.GITHUB_OUTPUT,
        `candidate_version=${candidateVersion}\n`,
        { flag: "a" },
      );
    }
    return;
  }
  if (command === "stage") {
    if (
      !UUID.test(journal.candidateVersion ?? "") ||
      active(deployments[0]).id !== journal.previous.id ||
      active(deployments[0]).version !== journal.previous.version
    ) {
      throw new Error("Prior deployment changed before candidate staging");
    }
    runWrangler(
      [
        "versions",
        "deploy",
        `${journal.previous.version}@100`,
        `${journal.candidateVersion}@0`,
        "--yes",
        "--message",
        `${journal.marker}:stage`,
      ],
      env,
    );
    const staged = verifyStagedCandidate(await listDeployments(env), journal);
    await writeFile(path, JSON.stringify(staged), { mode: 0o600 });
    return;
  }
  if (command === "promote") {
    verifyStagedCandidate(deployments, journal);
    runWrangler(
      [
        "versions",
        "deploy",
        `${journal.candidateVersion}@100`,
        "--yes",
        "--message",
        `${journal.marker}:promote`,
      ],
      env,
    );
    const promoted = verifyPromotedCandidate(
      await listDeployments(env),
      journal,
    );
    await writeFile(path, JSON.stringify(promoted), { mode: 0o600 });
    return;
  }
  if (command === "verify") {
    const verified = journal.staged
      ? verifyPromotedCandidate(deployments, journal)
      : verifyCandidate(deployments, journal);
    await writeFile(path, JSON.stringify(verified), { mode: 0o600 });
    return;
  }
  if (command === "recover") {
    if (!journal.staged && journal.candidateVersion) {
      if (deployments[0]?.id === journal.previous.id) {
        const live = active(deployments[0]);
        if (live.version === journal.previous.version) return;
        throw new Error("Production changed during candidate staging");
      }
      const staged = verifyStagedCandidate(deployments, journal);
      await restorePreviousVersion(deployments, staged, env);
      return;
    }
    if (
      journal.staged &&
      !journal.candidate &&
      deployments[0]?.annotations?.["workers/message"] ===
        `${journal.marker}:promote`
    ) {
      const promoted = verifyPromotedCandidate(deployments, journal);
      await restorePreviousVersion(deployments, promoted, env);
      return;
    }
    await restorePreviousVersion(deployments, journal, env);
    return;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv[2], process.env).catch((error) => {
    // Keep API responses and credentials out of CI logs.
    console.error(
      "Cloudflare deployment operation failed; inspect ownership and deployment state.",
    );
    process.exitCode = 1;
  });
}
