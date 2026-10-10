import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertOwnedCandidate,
  capturePrevious,
  restorePreviousVersion,
  parseUploadedVersion,
  verifyCandidate,
  verifyStagedCandidate,
  verifyPromotedCandidate,
  recoverManualSnapshot,
} from "./cloudflare-deployment.mjs";

const previousVersion = "11111111-1111-4111-8111-111111111111";
const candidateVersion = "22222222-2222-4222-8222-222222222222";
const priorId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const candidateId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const marker = "toolkit-mcp:123:1:0123456789abcdef0123456789abcdef01234567";

const previous = {
  id: priorId,
  versions: [{ version_id: previousVersion, percentage: 100 }],
};
const candidate = {
  id: candidateId,
  versions: [{ version_id: candidateVersion, percentage: 100 }],
  annotations: { "workers/message": marker },
};

const stagedId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const staged = {
  id: stagedId,
  versions: [
    { version_id: previousVersion, percentage: 100 },
    { version_id: candidateVersion, percentage: 0 },
  ],
  annotations: { "workers/message": `${marker}:stage` },
};
const promoted = {
  ...candidate,
  annotations: { "workers/message": `${marker}:promote` },
};

test("extracts only a confirmed upload of the production Worker", () => {
  const session = {
    type: "wrangler-session",
    command_line_args: [
      "versions",
      "upload",
      "--experimental-auto-create=false",
      "--config",
      "wrangler.jsonc",
    ],
  };
  const success = {
    type: "version-upload",
    worker_name: "sentry-mcp",
    worker_name_overridden: false,
    version_id: candidateVersion,
  };
  assert.equal(
    parseUploadedVersion(
      `${JSON.stringify(session)}\n${JSON.stringify(success)}\n`,
    ),
    candidateVersion,
  );
  assert.throws(
    () =>
      parseUploadedVersion(
        `${JSON.stringify(session)}\n${JSON.stringify({ ...success, worker_name: "sentry-mcp-canary" })}\n`,
      ),
    /production Worker/,
  );
  assert.throws(
    () =>
      parseUploadedVersion(
        `${JSON.stringify(session)}\n${JSON.stringify(success)}\n{}\n`,
      ),
    /Incomplete/,
  );
});

test("stages the uploaded candidate at zero percent and promotes that exact version", () => {
  const uploaded = {
    ...capturePrevious([previous], marker),
    candidateVersion,
  };
  const journal = verifyStagedCandidate([staged, previous], uploaded);
  assert.equal(journal.staged.id, stagedId);
  assert.equal(journal.candidateVersion, candidateVersion);
  const complete = verifyPromotedCandidate(
    [promoted, staged, previous],
    journal,
  );
  assert.equal(complete.candidate.version, candidateVersion);
});

test("rejects a different version, ownership marker, or earlier deployment", () => {
  const uploaded = {
    ...capturePrevious([previous], marker),
    candidateVersion,
  };
  const journal = verifyStagedCandidate([staged, previous], uploaded);
  assert.throws(
    () =>
      verifyStagedCandidate(
        [
          {
            ...staged,
            versions: [{ version_id: candidateVersion, percentage: 100 }],
          },
          previous,
        ],
        uploaded,
      ),
    /stage|traffic|ownership/i,
  );
  assert.throws(
    () => verifyPromotedCandidate([candidate, staged, previous], journal),
    /ownership|marker/i,
  );
  assert.throws(
    () =>
      verifyPromotedCandidate(
        [promoted, staged, { ...previous, id: candidateId }],
        journal,
      ),
    /prior|ownership/i,
  );
  assert.throws(
    () =>
      verifyPromotedCandidate(
        [promoted, { ...staged, id: priorId }, previous],
        journal,
      ),
    /stage|ownership/i,
  );
});

test("manual recovery derives the prior version only from contiguous owned history", () => {
  const journal = recoverManualSnapshot([promoted, staged, previous], marker);
  assert.equal(journal.previous.version, previousVersion);
  assert.equal(journal.candidateVersion, candidateVersion);
  assert.equal(journal.candidate.id, candidateId);
  assert.throws(
    () =>
      recoverManualSnapshot(
        [promoted, staged, previous],
        marker.replace(":123:", ":124:"),
      ),
    /ownership|marker/i,
  );
  assert.throws(
    () =>
      recoverManualSnapshot(
        [promoted, { ...staged, annotations: {} }, previous],
        marker,
      ),
    /ownership|marker/i,
  );
});

test("captures the live version before mutation and restores only the owned candidate", () => {
  const captured = capturePrevious([previous], marker);
  assert.deepEqual(captured.previous, {
    id: priorId,
    version: previousVersion,
  });
  const journal = verifyCandidate([candidate, previous], captured);
  assert.deepEqual(journal.candidate, {
    id: candidateId,
    version: candidateVersion,
  });
  assert.equal(
    assertOwnedCandidate([candidate, previous], journal),
    previousVersion,
  );
});

test("refuses restoration after external mutation at any lifecycle boundary", () => {
  const journal = verifyCandidate(
    [candidate, previous],
    capturePrevious([previous], marker),
  );
  const external = { ...candidate, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
  assert.throws(
    () => verifyCandidate([candidate, external, previous], journal),
    /ownership or prior version changed/,
  );
  assert.throws(
    () => assertOwnedCandidate([external, candidate, previous], journal),
    /ownership or prior version changed/,
  );
  assert.throws(
    () =>
      assertOwnedCandidate(
        [
          {
            ...candidate,
            versions: [{ version_id: previousVersion, percentage: 100 }],
          },
          previous,
        ],
        journal,
      ),
    /no longer runs this job's candidate/,
  );
  assert.throws(
    () =>
      assertOwnedCandidate(
        [
          { ...candidate, annotations: { "workers/message": "external" } },
          previous,
        ],
        journal,
      ),
    /ownership or prior version changed/,
  );
});

test("rejects ambiguous or malformed traffic allocations", () => {
  assert.throws(
    () => capturePrevious([], marker),
    /single active Worker version/,
  );
  assert.throws(
    () =>
      capturePrevious(
        [
          {
            ...previous,
            versions: [{ version_id: previousVersion, percentage: 99 }],
          },
        ],
        marker,
      ),
    /single active Worker version/,
  );
  assert.throws(
    () =>
      capturePrevious(
        [
          {
            ...previous,
            versions: [{ version_id: "../other", percentage: 100 }],
          },
        ],
        marker,
      ),
    /single active Worker version/,
  );
  assert.throws(
    () => verifyCandidate([candidate], capturePrevious([previous], marker)),
    /ownership or prior version changed/,
  );
  assert.throws(
    () =>
      verifyCandidate([candidate, previous], {
        ...capturePrevious([previous], marker),
        previous: { id: priorId, version: candidateVersion },
      }),
    /ownership or prior version changed/,
  );
});

test("restores only the captured version and checks Cloudflare's resulting state", async () => {
  const journal = verifyCandidate(
    [candidate, previous],
    capturePrevious([previous], marker),
  );
  const env = { GITHUB_RUN_ID: "123" };
  const calls = [];
  await restorePreviousVersion([candidate, previous], journal, env, {
    spawn: (...args) => {
      calls.push(args);
      return { status: 0 };
    },
    list: async () => [previous, candidate],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "pnpm");
  assert.deepEqual(calls[0][1], [
    "exec",
    "wrangler",
    "versions",
    "deploy",
    `${previousVersion}@100`,
    "--yes",
    "--message",
    "Toolkit recovery 123",
  ]);
  assert.equal(calls[0][2].env, env);
});

test("never restores when ownership changed or the journal is malformed", async () => {
  const journal = verifyCandidate(
    [candidate, previous],
    capturePrevious([previous], marker),
  );
  const calls = [];
  const spawn = (...args) => {
    calls.push(args);
    return { status: 0 };
  };
  const env = { GITHUB_RUN_ID: "123" };
  await assert.rejects(
    restorePreviousVersion(
      [
        { ...candidate, annotations: { "workers/message": "external" } },
        previous,
      ],
      journal,
      env,
      { spawn },
    ),
    /ownership or prior version changed/,
  );
  await assert.rejects(
    restorePreviousVersion(
      [candidate, previous],
      { ...journal, previous: { ...journal.previous, version: "../other" } },
      env,
      { spawn },
    ),
    /ownership or prior version changed/,
  );
  assert.equal(calls.length, 0);
});
