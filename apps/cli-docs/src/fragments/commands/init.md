

## Setting up Sentry with an agent

`sentry init` prints a guide for a coding agent to follow; it changes nothing
itself. Ask your agent to run it:

> Set up Sentry for me. Run `sentry init` and follow the steps.

If the CLI isn't installed yet, point the agent at the published copy, which
starts by installing it:

> Set up Sentry for me. Fetch https://cli.sentry.dev/get-started-with-sentry.md and follow it.

When the output is piped, as it is for agents, the command prints the guide's
Markdown source. In a terminal it renders the guide.

## What the guide covers

1. Install the CLI and log in with `sentry auth login`
2. Map the project: which apps to set up, which SDKs each one needs (a
   framework on a specific runtime, such as TanStack Start on Cloudflare,
   needs both SDKs), and whether Sentry is already there. If it is, upgrade
   the SDKs or turn on more features instead
3. Pick or create a Sentry project and read its DSN
4. Choose features: errors, tracing, logs, metrics, Session Replay, profiling,
   crons, User Feedback, AI agent monitoring, and MCP monitoring
5. Install and configure the SDKs from the current docs (`sentry docs`), never
   from remembered versions or APIs
6. Verify that a test error reaches Sentry with `sentry local run --verify`
   and `sentry issue list`
7. Report what changed and what is left for you to do
