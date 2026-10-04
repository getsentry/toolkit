import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(
  new URL("../.github/workflows/deploy.yml", import.meta.url),
  "utf8",
);
const recovery = readFileSync(
  new URL(
    "../.github/workflows/recover-cloudflare-deployment.yml",
    import.meta.url,
  ),
  "utf8",
);
const smoke = readFileSync(
  new URL("../packages/smoke-tests/src/smoke.test.ts", import.meta.url),
  "utf8",
);

test("production deploy requires a successful Test run on this repository's main branch", () => {
  assert.doesNotMatch(workflow, /if:\s*\$\{\{\s*false\s*\}\}/);
  assert.match(workflow, /workflow_run\.conclusion == 'success'/);
  assert.match(workflow, /workflow_run\.event == 'push'/);
  assert.match(
    workflow,
    /workflow_run\.head_repository\.id == github\.event\.repository\.id/,
  );
  assert.match(workflow, /workflow_run\.head_branch == 'main'/);
  assert.doesNotMatch(workflow, /^\s*workflow_dispatch:/m);
  assert.match(
    workflow,
    /ref:\s*\$\{\{ github\.event\.workflow_run\.head_sha \}\}/,
  );
  assert.match(workflow, /environment:\s*production/);
  assert.match(workflow, /group:\s*mcp-production-deploy/);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /cloudflare-deployment\.mjs capture/);
  assert.match(workflow, /cloudflare-deployment\.mjs uploaded/);
  assert.match(workflow, /cloudflare-deployment\.mjs stage/);
  assert.match(workflow, /cloudflare-deployment\.mjs promote/);
  assert.match(workflow, /cloudflare-deployment\.mjs verify/);
  assert.match(workflow, /cloudflare-deployment\.mjs recover/);
  assert.match(
    workflow,
    /wrangler versions upload --experimental-auto-create=false/,
  );
  assert.doesNotMatch(workflow, /wrangler deploy --config wrangler\.canary/);
  assert.match(
    workflow,
    /CLOUDFLARE_VERSION_OVERRIDE: \$\{\{ steps\.uploaded\.outputs\.candidate_version \}\}/,
  );
  assert.equal(
    (
      workflow.match(
        /EXPECTED_VERSION_ID: \$\{\{ steps\.uploaded\.outputs\.candidate_version \}\}/g,
      ) ?? []
    ).length,
    2,
  );
  assert.match(
    workflow,
    /pnpm --filter '@sentry\/mcp-cloudflare\.\.\.' run build/,
  );
  assert.match(
    workflow,
    /SENTRY_AUTH_TOKEN: \$\{\{ secrets\.SENTRY_AUTH_TOKEN \}\}/,
  );
  assert.match(
    workflow,
    /VITE_SENTRY_DSN: \$\{\{ secrets\.VITE_SENTRY_DSN \}\}/,
  );
});

test("deployment failures never invoke an unqualified rollback", () => {
  assert.doesNotMatch(workflow, /(?:command:|pnpm exec wrangler)\s+rollback\b/);
  assert.match(
    workflow,
    /failure\(\) && steps\.uploaded\.outcome == 'success'/,
  );
  assert.doesNotMatch(workflow, /continue-on-error:\s*true/);
  assert.doesNotMatch(recovery, /(?:command:|pnpm exec wrangler)\s+rollback\b/);
});

test("JUnit publication cannot trigger recovery after a successful deployment", () => {
  const restore = workflow.indexOf(
    "name: Recover captured previous version if owned transition fails",
  );
  assert.ok(restore !== -1);
  assert.ok(
    workflow.indexOf("name: Publish Candidate Smoke Test Report") < restore,
  );
  assert.ok(
    workflow.indexOf("name: Publish Production Smoke Test Report") > restore,
  );
});

test("manual recovery requires the current main and a completed same-repo deploy run", () => {
  assert.match(recovery, /^\s*workflow_dispatch:/m);
  assert.match(recovery, /github\.ref == 'refs\/heads\/main'/);
  assert.match(recovery, /github\.event\.repository\.id == 957245447/);
  assert.match(recovery, /\.repository_id == \$repository/);
  assert.match(recovery, /\.status == "completed"/);
  assert.match(recovery, /\.path == "\.github\/workflows\/deploy\.yml"/);
  assert.match(
    recovery,
    /actions\/runs\/\$SOURCE_RUN_ID\/attempts\/\$SOURCE_RUN_ATTEMPT/,
  );
  assert.match(recovery, /ALLOW_LEGACY_VERSION_ENDPOINT: "1"/);
  assert.match(recovery, /Wait for restored version to propagate/);
  assert.match(recovery, /sleep 30/);
  assert.match(smoke, /ALLOW_LEGACY_VERSION_ENDPOINT/);
  assert.match(smoke, /response\.status === 404/);
  assert.match(recovery, /cloudflare-deployment\.mjs manual/);
  assert.match(recovery, /group:\s*mcp-production-deploy/);
  assert.match(recovery, /environment:\s*production/);
});

test("external actions use immutable commit pins", () => {
  for (const [, action] of `${workflow}\n${recovery}`.matchAll(
    /^\s*(?:- )?uses:\s*([^\s#]+)/gm,
  )) {
    assert.match(action, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, action);
  }
});
