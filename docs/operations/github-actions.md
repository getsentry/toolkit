# GitHub Actions

CI/CD workflows for the Sentry MCP project.

`pnpm build` builds the MCP workspace; `pnpm build:cli` builds the imported CLI
and docs when `SENTRY_CLIENT_ID` is available.

## Workflows

### test.yml
Runs on pushes to `main`, pull requests, and merge queue entries. Discovery
reads pnpm workspace projects and their package scripts. Pull requests check
changed projects, their workspace consumers, and semantic dependencies (the CLI
docs depend on `sentry`). Root-level changes and non-PR events check every
enabled project. Each project has its own build, lint, typecheck, test, policy,
and E2E steps when those scripts exist. The always-present `test` job checks
discovery, installation, repository quality, and every selected project.
Package-specific exceptions live in `package.json#sentryCi`; the standalone
smoke-test suite remains in its own workflow.

### deploy.yml
Runs after a successful `Test` push run on `main`. Checks out the tested commit
and requires that it is still the tip of `main`. Builds once, records the active
production version, and uploads one new version of `sentry-mcp`. It stages the
candidate at 0% alongside the old version at 100%, then runs smoke tests
through the production route with a version override on every request. The
version endpoint confirms the override reaches the candidate. Only then does
it promotes the tested version to 100% and repeats the smoke tests. On failure
it restores the exact captured prior version only if the live deployments still
belong to this run.

### recover-cloudflare-deployment.yml
Manual `workflow_dispatch` recovery accepts a deployment run ID and attempt.
It runs trusted current-`main` code in the protected `production` environment,
checks the completed source run, and derives the prior version from contiguous
run-owned Cloudflare deployment history. It refuses an intervening deployment,
split or ambiguous traffic, or a marker mismatch. A successful restore is
verified against Cloudflare and the live Worker. Recovery never builds or
deploys source code from the old run. The first restored version may predate
`/_health/version`; in that case, Cloudflare's active-version check and the
functional smoke tests verify recovery while the version-route test accepts
only its 404 response. When the route exists, the smoke test compares its
version ID with the restored version.

### migrate-cloudflare-token.yml
Moves the Cloudflare API token from a repository secret into the protected
`production` environment. Only `main` in the Toolkit repository can run it.
Copy and removal are separate dispatches so a normal production deployment can
prove that the environment copy works before the repository copy is deleted.

### eval.yml
Runs evaluation tests against the MCP server.

### pr-risk-jev.yml
Classifies PR risk with Jev and publishes one `risk: low`, `risk: medium`, or
`risk: high` label. Runs when a non-draft PR is opened, updated with a push,
reopened, marked ready for review, or edited. Manual dispatch accepts a PR number
and also supports drafts.

The pinned risk Action reads PR metadata and Git diffs without checking out or
executing PR code. Labels are only published for the analyzed revision; unrelated
labels are preserved. An unchanged classification makes no label changes.
If a current-revision analysis fails, previous risk labels
are cleared and the PR stays unclassified. Results are retained as workflow
artifacts for 30 days.

### pr-risk-labels-test.yml
Runs the label publisher's regression tests when its workflow or tests change.
Covers label replacement, stale revisions, failed classifications, and concurrent
label creation.

## Required Secrets

The `production` environment is restricted to `main` and holds:

- **`CLOUDFLARE_API_TOKEN`** - Cloudflare API token with Workers deployment permissions

During migration, the same name also exists as a repository secret. A temporary
`CLOUDFLARE_MIGRATION_PAT` environment secret gives the migration workflow
permission to write environment secrets and delete the repository copy. The
workflow deletes this PAT secret after successful cleanup.

Other configuration:

- **`CLOUDFLARE_ACCOUNT_ID`** - ID of the account owning the Workers
- **`SENTRY_AUTH_TOKEN`** - For Sentry release tracking
- **`SENTRY_CLIENT_SECRET`** - Sentry OAuth client secret
- **`COOKIE_SECRET`** - Session cookie encryption secret
- **`OPENAI_API_KEY`** - For AI-powered search features
- **`AI_GATEWAY_API_KEY`** - Vercel AI Gateway key for Jev PR risk classification

## Deployment Architecture

### Workers
- **`sentry-mcp`** - Production worker at `https://mcp.sentry.dev`
- The candidate is tested on the production Worker at 0% traffic before promotion.

### Resource Isolation
The existing canary Worker has separate resources; exact-version rollout does
not deploy it. The production candidate uses the production bindings:

| Resource | Production | Canary |
|----------|------------|---------|
| KV Namespace | `8dd5e9bafe1945298e2d5ca3b408a553` | `a3fe0d23b2d34416930e284362a88a3b` |
| Rate Limiter IDs | `1001`, `1002`, `1003`, `1004` | `2001`, `2002`, `2003`, `2004` |
| Wrangler Config | `wrangler.jsonc` | `wrangler.canary.jsonc` |

### Deployment Flow

The workflow never deploys an untested revision or a stale `main` commit.
Failure to identify the prior active version, verify deployment ownership, or
confirm the restored version fails the job rather than guessing a recovery.

## Manual Deployment

Manual dispatch cannot deploy a new revision. Use a reviewed change and its
passing `Test` run to deploy. To restore an owned deployment after its runner
has stopped, dispatch `Recover Cloudflare Deployment` from `main` with the
failed deployment run ID and attempt. Verify the active Cloudflare version and
live smoke-test result; if ownership has changed, investigate rather than
retrying against mutable history. Never run bare `wrangler rollback`.

## Cloudflare token migration

1. Merge the reviewed migration workflow into `main`. Create a fine-grained PAT
   for `getsentry/toolkit` with repository **Secrets: read/write** permission.
   Store it as `CLOUDFLARE_MIGRATION_PAT` in the protected `production`
   environment. Never pass the PAT in a workflow input or command argument.
2. Dispatch `Move Cloudflare token to production environment` on `main` with
   `operation=copy`. Confirm success and check that `CLOUDFLARE_API_TOKEN`
   appears in both repository and `production` environment secret-name lists.
3. Wait for a normal `Test` push on `main` to trigger `Deploy to Cloudflare`.
   Confirm that the deployment passed canary and production smoke tests and
   served the intended revision. Record its workflow run ID; its start time
   must be after the environment secret was copied.
4. Dispatch the migration workflow again on `main` with `operation=remove` and
   that successful deployment run ID. The workflow checks the run's identity,
   result, timing, and successful canary and production deployment and smoke-test
   steps, then deletes the repository-scoped Cloudflare token.
   Check that only the environment copy remains and the temporary PAT secret
   has been removed. Revoke the PAT after use.

If a step fails, keep the repository copy until a successful post-copy
deployment has been verified. Never print either credential while diagnosing
the failure.

## Troubleshooting

1. **Authentication failed** - Check `CLOUDFLARE_API_TOKEN` permissions
2. **Build failures** - Review TypeScript/build logs
3. **Smoke test failures** - Check worker logs in Cloudflare dashboard
