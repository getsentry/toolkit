
## Run Code

The run code is a private 10-character token that links progress updates to a
specific user's onboarding page. It comes from the onboarding page or the
agent handoff guide. Keep it private — never print, log, or share it.

Pass it with `--run-code` or set `SENTRY_ONBOARDING_RUN_CODE`.

## Stopping Updates

Stop calling `sentry onboarding progress` when any of the following happens:

- The command exits with the stop message: "This onboarding run no longer
  accepts updates."
- The JSON output contains `continueUpdates: false`.

A failed progress call is never a reason to stop the setup itself.

## Stage Metadata

Two stages accept extra metadata:

- `create_project`: pass created or selected project slugs with `--project`.
  Slugs accumulate across calls; include each project as it becomes usable,
  then all known projects on completion.
- `receive_verification_error`: pass confirmed Sentry issue IDs with `--issue`.
  Include each matching issue ID as it is confirmed.

Using `--project` or `--issue` on any other stage is an error.
