# Design

Each file states the intent of one major system: the goals it must meet,
where users reach it, and the rules users rely on. Teammates read it to learn
why the system works the way it does. Agents read it before they change the
system. The `create-design-docs` skill writes these files, and the
`maintain-design-docs` skill checks the product against them.

## File contract

Each file has an H1 title and one paragraph that says what the user gets.
Then it has these H2 sections, in this order:

1. `Intent`: the goals that the system must meet, and why. Each goal
   decides between real options, such as "runs work with no person
   present".
2. `Entry points`: each place where a user reaches the system, by its
   visible name.
3. `Rules`: limits that users rely on, such as who can act, and what the
   system is not.
4. `Gaps`: only when the product does not meet a goal or a rule yet. Say
   how it falls short, and which goal or rule it breaks.

These files state intent. The code shows what the product does, not what it
should do. Do not change a goal or a rule only to match the code. Name only
user actions, visible names, required access, and outcomes that a user can
see. Leave out source paths, symbols, schemas, history, and rollout notes.

Do not list behaviors. When the repo has a verification skill, its map owns
each behavior as a claim with a proof. Name a behavior only by its claim ID,
such as `automations#run-now`, and do not restate it.

## Systems

- [MCP tools](./mcp-tools.md): the Sentry tools an agent can list and call, and how it finds the right one.
- [MCP tool responses](./mcp-tool-responses.md): what a tool result gives an agent to answer a Sentry question.
- [MCP access](./mcp-access.md): who can use Sentry MCP, over which transport, and what a session can reach.
- [Sentry CLI](./sentry-cli.md): the `sentry` command for people and agents in a terminal.
- [Sentry Local](./sentry-local.md): the app telemetry `sentry local` captures on a developer's machine, with no account.
