import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKER = "sentry-mcp";
const SETTLE_ATTEMPTS = 15;
const SETTLE_DELAY_MS = 2_000;

// Messages are fixed strings, so they are safe to print in CI logs, unlike
// errors from fetch or JSON parsing that may carry API content.
class DeploymentError extends Error {}

// A leftover stage serves one version at 100% beside a candidate at 0%. That
// routes traffic exactly like a single-version deployment, so it must not block
// every later deployment.
function active(deployment) {
  const versions = deployment?.versions;
  const serving = Array.isArray(versions)
    ? versions.filter((version) => version?.percentage === 100)
    : [];
  if (
    !UUID.test(deployment?.id ?? "") ||
    serving.length !== 1 ||
    !versions.every(
      (version) =>
        UUID.test(version?.version_id ?? "") &&
        (version === serving[0] || version.percentage === 0),
    )
  ) {
    throw new DeploymentError(
      "Expected a single active Worker version at 100% traffic",
    );
  }
  return { id: deployment.id, version: serving[0].version_id };
}

function newestMessage(deployments) {
  return deployments[0]?.annotations?.["workers/message"];
}

export function capturePrevious(deployments, marker) {
  if (
    !Array.isArray(deployments) ||
    !/^toolkit-mcp:\d+:\d+:[0-9a-f]{40}$/.test(marker)
  ) {
    throw new DeploymentError("Missing deployment history or run identity");
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
    throw new DeploymentError(
      "Candidate stage must contain the previous version at 100% and candidate at 0%",
    );
  }
  return { id: deployment.id };
}

export function verifyStagedCandidate(deployments, journal) {
  if (!Array.isArray(deployments) || !journal?.previous || !journal?.marker) {
    throw new DeploymentError(
      "Missing candidate stage or previous-version journal",
    );
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
    throw new DeploymentError(
      "Candidate stage ownership or prior version changed",
    );
  }
  return { ...journal, staged };
}

export function verifyPromotedCandidate(deployments, journal) {
  if (!Array.isArray(deployments) || !journal?.staged) {
    throw new DeploymentError("Missing verified candidate stage");
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
    throw new DeploymentError(
      "Promotion ownership or candidate version changed",
    );
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
    throw new DeploymentError("Invalid manual recovery run identity");
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
  throw new DeploymentError(
    "Latest deployment is not owned by the requested run marker",
  );
}

export function verifyCandidate(deployments, journal) {
  if (!Array.isArray(deployments) || !journal?.previous || !journal.marker) {
    throw new DeploymentError(
      "Missing deployment history or previous-version journal",
    );
  }
  const candidate = active(deployments[0]);
  if (
    candidate.id === journal.previous.id ||
    deployments[0].annotations?.["workers/message"] !== journal.marker ||
    deployments[1]?.id !== journal.previous.id ||
    active(deployments[1]).version !== journal.previous.version
  ) {
    throw new DeploymentError(
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
    throw new DeploymentError(
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
    throw new DeploymentError(
      "Cloudflare account ID and API token are required",
    );
  }
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${WORKER}/deployments?per_page=3`,
    {
      headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    throw new DeploymentError("Cloudflare deployment lookup failed");
  }
  const body = await response.json();
  if (body.success !== true || !Array.isArray(body.result?.deployments)) {
    throw new DeploymentError("Cloudflare returned an invalid deployment list");
  }
  return body.result.deployments;
}

// Cloudflare can keep listing the previous deployment first for a few seconds
// after `wrangler versions deploy` succeeds. Re-read until `settled` holds;
// callers still validate whatever the final read returns.
export async function listSettled(
  env,
  settled,
  { list = listDeployments, sleep = delay } = {},
) {
  let deployments = await list(env);
  for (
    let attempt = 1;
    attempt < SETTLE_ATTEMPTS && !settled(deployments);
    attempt++
  ) {
    await sleep(SETTLE_DELAY_MS);
    deployments = await list(env);
  }
  return deployments;
}

function runMarker(env) {
  if (
    !/^[1-9]\d*$/.test(env.SOURCE_RUN_ID ?? env.GITHUB_RUN_ID ?? "") ||
    !/^[1-9]\d*$/.test(
      env.SOURCE_RUN_ATTEMPT ?? env.GITHUB_RUN_ATTEMPT ?? "",
    ) ||
    !/^[0-9a-f]{40}$/.test(env.SOURCE_SHA ?? env.TESTED_SHA ?? "")
  ) {
    throw new DeploymentError("Invalid GitHub run identity");
  }
  return `toolkit-mcp:${env.SOURCE_RUN_ID ?? env.GITHUB_RUN_ID}:${env.SOURCE_RUN_ATTEMPT ?? env.GITHUB_RUN_ATTEMPT}:${env.SOURCE_SHA ?? env.TESTED_SHA}`;
}

function runWrangler(args, env, spawn = spawnSync) {
  const child = spawn("pnpm", ["exec", "wrangler", ...args], {
    cwd: join(import.meta.dirname, "../packages/mcp-cloudflare"),
    env,
    stdio: "inherit",
  });
  if (child.error) throw new DeploymentError("Wrangler could not start");
  if (child.status !== 0)
    throw new DeploymentError("Cloudflare version transition failed");
}

export function parseUploadedVersion(output) {
  if (typeof output !== "string" || output.length > 64_000) {
    throw new DeploymentError("Invalid Wrangler upload output");
  }
  const lines = output.trimEnd().split("\n");
  if (lines.length !== 2)
    throw new DeploymentError("Incomplete Wrangler upload output");
  let session;
  let success;
  try {
    [session, success] = lines.map((line) => JSON.parse(line));
  } catch {
    throw new DeploymentError("Invalid Wrangler upload output");
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
    throw new DeploymentError(
      "Wrangler did not confirm a production Worker version upload",
    );
  }
  return success.version_id;
}

export async function restorePreviousVersion(
  deployments,
  journal,
  env,
  { list = listDeployments, sleep = delay, spawn = spawnSync } = {},
) {
  const previous = assertOwnedCandidate(deployments, journal);
  if (!UUID.test(previous)) {
    throw new DeploymentError("Invalid captured previous version");
  }
  const message = `Toolkit recovery ${env.GITHUB_RUN_ID}`;
  runWrangler(
    ["versions", "deploy", `${previous}@100`, "--yes", "--message", message],
    env,
    spawn,
  );
  const current = await listSettled(
    env,
    (listed) => newestMessage(listed) === message,
    { list, sleep },
  );
  const recovered = active(current[0]);
  if (recovered.version !== previous || recovered.id === deployments[0].id) {
    throw new DeploymentError(
      "Cloudflare did not activate the captured previous version",
    );
  }
}

// Recovers after `stage` failed before verifying its deployment. An unchanged
// newest deployment may be a stale read, not proof that staging never happened.
export async function recoverUnverifiedStage(journal, env, options = {}) {
  const current = await listSettled(
    env,
    (listed) => listed[0]?.id !== journal.previous.id,
    options,
  );
  if (current[0]?.id === journal.previous.id) {
    if (journal.stageDeployed) {
      throw new DeploymentError(
        "Cloudflare does not list the staged candidate; run manual recovery",
      );
    }
    if (active(current[0]).version === journal.previous.version) return;
    throw new DeploymentError("Production changed during candidate staging");
  }
  const staged = verifyStagedCandidate(current, journal);
  await restorePreviousVersion(current, staged, env, options);
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
    throw new DeploymentError("Unknown Cloudflare deployment operation");
  }
  if (!env.RUNNER_TEMP) {
    throw new DeploymentError("RUNNER_TEMP is required");
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
    throw new DeploymentError("Deployment journal belongs to another run");
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
      throw new DeploymentError("Production changed during candidate upload");
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
      throw new DeploymentError(
        "Prior deployment changed before candidate staging",
      );
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
    // Tells recovery that a stage exists even if Cloudflare does not list it.
    const deployed = { ...journal, stageDeployed: true };
    await writeFile(path, JSON.stringify(deployed), { mode: 0o600 });
    const staged = verifyStagedCandidate(
      await listSettled(
        env,
        (listed) => newestMessage(listed) === `${journal.marker}:stage`,
      ),
      deployed,
    );
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
      await listSettled(
        env,
        (listed) => newestMessage(listed) === `${journal.marker}:promote`,
      ),
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
      await recoverUnverifiedStage(journal, env);
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
    const reason =
      error instanceof DeploymentError ? error.message : "unexpected error";
    console.error(
      `Cloudflare deployment operation failed (${reason}); inspect ownership and deployment state.`,
    );
    process.exitCode = 1;
  });
}
