import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";
import plugin from "../packages/cli/lint-rules/cli-oxlint-plugin.js";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
});
const source = "/repo/packages/cli/src/lib/example.ts";
const commands = "/repo/packages/cli/src/commands/example.ts";
const release = "/repo/packages/cli/src/commands/release/example.ts";
const api = "/repo/packages/cli/src/lib/api/example.ts";

for (const [name, filename, valid, invalid] of [
  [
    "no-silent-catch",
    source,
    "try { work(); } catch (error) { log.warn(error); }",
    "try { work(); } catch (error) { return null; }",
  ],
  [
    "no-stdout-write-in-commands",
    commands,
    "async function* run() { yield new CommandOutput(value); }",
    "stdout.write(value);",
  ],
  [
    "no-process-stdout-in-commands",
    commands,
    "async function* run() { yield new CommandOutput(value); }",
    "process.stdout.write(value);",
  ],
  [
    "no-stderr-write-in-commands",
    commands,
    "log.warn(value);",
    "stderr.write(value);",
  ],
  [
    "no-raw-metadata-queries",
    source,
    "getMetadata(db, key);",
    "db.query('SELECT value FROM metadata WHERE key = ?');",
  ],
  [
    "no-manual-transactions",
    source,
    "db.transaction(fn)();",
    "db.exec('BEGIN');",
  ],
  [
    "no-inline-touch-cache",
    source,
    "touchCacheEntry(db, key);",
    "db.query('UPDATE entries SET last_accessed = ?').run(now);",
  ],
  [
    "no-args-join-in-release",
    release,
    "resolveReleaseTarget(args);",
    "args.join(' ');",
  ],
  [
    "no-direct-target-resolution",
    commands,
    "resolveProjectTarget(args);",
    "findProjectsBySlug(args);",
  ],
  [
    "no-generic-is-record",
    source,
    "function hasFileMap(value) { return true; }",
    "function isRecord(value) { return true; }",
  ],
  [
    "prefer-paginate-helper",
    api,
    "paginate(fetcher, limit);",
    "autoPaginate(fetcher, limit);",
  ],
  [
    "no-namespace-import",
    source,
    "import { spyOn } from 'vitest';",
    "import * as utilities from './utilities.js';",
  ],
  [
    "no-skipped-tests",
    "/repo/packages/cli/test/example.test.ts",
    "it('works', () => {});",
    "it.skip('works', () => {});",
  ],
]) {
  tester.run(name, plugin.rules[name], {
    valid: [{ filename, code: valid }],
    invalid: [{ filename, code: invalid, errors: 1 }],
  });
}

tester.run("no-silent-catch", plugin.rules["no-silent-catch"], {
  valid: [
    {
      filename: source,
      code: "try { work(); } catch (error: unknown) { throw error; }",
    },
    {
      filename: source,
      code: "request.catch((error) => { return handle(error); });",
    },
  ],
  invalid: [
    {
      filename: source,
      code: "try { work(); } catch (error: unknown) { return null; }",
      errors: 1,
    },
    {
      filename: source,
      code: "request.catch((error) => { return null; });",
      errors: 1,
    },
  ],
});

tester.run("no-ad-hoc-id-arguments", plugin.rules["no-ad-hoc-id-arguments"], {
  valid: [
    {
      filename: commands,
      code: "import { HEX_ID_RE } from './hex-id.js'; parseIdArguments(args, ID_KINDS.trace, options);",
    },
    {
      filename: "/repo/packages/cli/src/lib/id-arguments.ts",
      code: "parseIdArguments(args, kind, options);",
    },
  ],
  invalid: [
    {
      filename: commands,
      code: "parseSlashSeparatedArg(arg, label, hint);",
      errors: 1,
    },
    {
      // No command is exempt, not even `event view`, which also takes issues
      filename: "/repo/packages/cli/src/commands/event/view.ts",
      code: "parseSlashSeparatedArg(arg, label, hint);",
      errors: 1,
    },
    {
      filename: commands,
      code: "const swapped = detectSwappedViewArgs(first, second);",
      errors: 1,
    },
    { filename: commands, code: "HEX_ID_RE.test(value);", errors: 1 },
    {
      filename: source,
      code: "parseIdArguments(args, { label: 'Thing ID', isId }, options);",
      errors: 1,
    },
  ],
});

tester.run(
  "require-target-resolution",
  plugin.rules["require-target-resolution"],
  {
    valid: [
      {
        filename: commands,
        code: "async function* run(flags, target: ReleaseTarget) { const { org } = await target.resolved; }",
      },
      {
        filename: commands,
        code: "import { parseOrgProjectArg } from './arg-parsing.js'; type Parsed = ReturnType<typeof parseOrgProjectArg>;",
      },
      {
        // Libraries implement the bound positionals
        filename: source,
        code: "const parsed = parseOrgProjectArg(target);",
      },
    ],
    invalid: [
      {
        filename: commands,
        code: "async function* run(flags, target: ReleaseTarget) { return target.parsed; }",
        errors: 1,
      },
      {
        filename: commands,
        code: "async function* run(flags, issues: IssuesArguments) { return issues.parsed; }",
        errors: 1,
      },
      {
        // Tagging a raw parser leaves the target for func to parse
        filename: commands,
        code: "const org = { parse: withCompletionTarget(ORG_TARGET, String) };",
        errors: 1,
      },
      {
        filename: commands,
        code: "async function* run(flags, arg) { const parsed = parseOrgProjectArg(arg); }",
        errors: 1,
      },
      {
        filename: commands,
        code: "const org = await resolveOrgOnlyFromArg(arg, cwd, 'alert metrics view');",
        errors: 1,
      },
    ],
  },
);

tester.run(
  "require-completion-parser",
  plugin.rules["require-completion-parser"],
  {
    valid: [
      {
        filename: commands,
        code: "const flags = { limit: { kind: 'parsed', parse: textParser(Number), brief: 'Limit' } };",
      },
      {
        filename: commands,
        code: "const flags = { query: { kind: 'parsed', parse: parseText, brief: 'Query' }, sort: { kind: 'parsed', parse: choiceParser(SORTS, parseSort), brief: 'Sort' } };",
      },
      {
        // boundArguments declares its completion kind next to its parser
        filename: commands,
        code: "boundArguments({ placeholder: 'issue', brief: 'Issue', kind: ISSUE_TARGET, parse: (raw) => parseIssues(raw), resolve });",
      },
      {
        // Not a command parameter
        filename: commands,
        code: "const schema = { parse: (value) => value };",
      },
      {
        // Outside command definitions and their helpers
        filename: "/repo/packages/cli/script/example.ts",
        code: "const flags = { port: { kind: 'parsed', parse: Number, brief: 'Port' } };",
      },
      {
        filename: commands,
        code: "const flags = { port: { kind: 'parsed', parse: Number, brief: 'Port' } };",
        options: [
          {
            exemptions: [
              {
                file: "src/commands/example.ts",
                command: "example",
                parameter: "--port",
                reason: "test",
              },
            ],
          },
        ],
      },
      {
        filename: commands,
        code: "const positional = { kind: 'tuple', parameters: [{ placeholder: 'when', brief: 'When', parse: Date }] };",
        options: [
          {
            exemptions: [
              {
                file: "src/commands/example.ts",
                command: "example",
                parameter: "<when>",
                reason: "test",
              },
            ],
          },
        ],
      },
      {
        // A flag with a placeholder is still named by its flag name
        filename: commands,
        code: "const flags = { method: { kind: 'parsed', parse: String, brief: 'Method', placeholder: 'method' } };",
        options: [
          {
            exemptions: [
              {
                file: "src/commands/example.ts",
                command: "example",
                parameter: "--method",
                reason: "test",
              },
            ],
          },
        ],
      },
      {
        filename: commands,
        code: "const positional = { kind: 'array', parameter: { placeholder: 'path', brief: 'Path', parse: String } };",
        options: [
          {
            exemptions: [
              {
                file: "src/commands/example.ts",
                command: "example",
                parameter: "<path>",
                reason: "test",
              },
            ],
          },
        ],
      },
    ],
    invalid: [
      {
        filename: commands,
        code: "const flags = { port: { kind: 'parsed', parse: Number, brief: 'Port' } };",
        errors: 1,
      },
      {
        filename: commands,
        code: "const flags = { name: { kind: 'parsed', parse: String, brief: 'Name' } };",
        errors: 1,
      },
      {
        filename: commands,
        code: "const flags = { data: { kind: 'parsed', parse: JSON.parse, brief: 'Data' } };",
        errors: 1,
      },
      {
        filename: commands,
        code: "const flags = { port: { kind: 'parsed', parse: (value) => Number(value), brief: 'Port' } };",
        errors: 1,
      },
      {
        filename: commands,
        code: "const flags = { port: { kind: 'parsed', parse(value) { return Number(value); }, brief: 'Port' } };",
        errors: 1,
      },
      {
        // Positionals too, and lib helpers that build parameters
        filename: source,
        code: "const positional = { kind: 'tuple', parameters: [{ placeholder: 'count', brief: 'Count', parse: parseInt }] };",
        errors: 1,
      },
      {
        filename: commands,
        code: "boundArguments({ placeholder: 'issue', brief: 'Issue', parse: (raw) => parseIssues(raw), resolve });",
        errors: 1,
      },
      {
        // An exemption covers only the parameter it names
        filename: commands,
        code: "const flags = { port: { kind: 'parsed', parse: Number, brief: 'Port' } };",
        options: [
          {
            exemptions: [
              {
                file: "src/commands/example.ts",
                command: "example",
                parameter: "--limit",
                reason: "test",
              },
            ],
          },
        ],
        errors: 1,
      },
    ],
  },
);

tester.run("no-raw-metadata-queries", plugin.rules["no-raw-metadata-queries"], {
  valid: [
    {
      filename: source,
      code: "db.query(); const unrelated = 'SELECT value FROM metadata';",
    },
    {
      filename: "/repo/packages/cli/src/lib/db/utils.ts",
      code: "db.query('SELECT value FROM metadata');",
    },
  ],
  invalid: [
    {
      filename: source,
      code: "runUpsert(db, 'metadata', data, keys);",
      errors: 1,
    },
  ],
});

tester.run(
  "no-examples-in-full-description",
  plugin.rules["no-examples-in-full-description"],
  {
    valid: [
      {
        filename: commands,
        code: "buildCommand({ docs: { fullDescription: 'Lists items.', examples: [{ description: 'List', command: 'sentry list' }] } });",
      },
      {
        filename: commands,
        code: "buildCommand({ docs: { fullDescription: 'Format: count()\\n  Example: p50(value)' } });",
      },
      {
        filename: commands,
        code: "buildCommand({ docs: { fullDescription: 'Lists items.\\n\\nRun `sentry item view` for details.' } });",
      },
      {
        filename: commands,
        code: "throw new ContextError('Item', 'sentry item view <id>\\n  sentry item list');",
      },
      {
        filename: commands,
        code: "throw new ValidationError('Bad input.\\n\\nExamples:\\n  sentry list');",
      },
      {
        filename: source,
        code: "const docs = { fullDescription: `${base}\\n\\nExamples:\\n${rendered}` };",
      },
    ],
    invalid: [
      {
        filename: commands,
        code: "buildCommand({ docs: { fullDescription: 'Lists items.\\n\\n' + 'Examples:\\n' + '  sentry list\\n' } });",
        errors: 1,
      },
      {
        filename: commands,
        code: "buildRouteMap({ docs: { fullDescription: `Manage items.\\n\\nExample:\\n  sentry item view 1` } });",
        errors: 1,
      },
      {
        filename: commands,
        code: "buildCommand({ docs: { fullDescription: 'Manage items.\\n\\n' + '## Examples\\n\\n' + 'sentry item list\\n' } });",
        errors: 1,
      },
      {
        filename: commands,
        code: "buildCommand({ docs: { fullDescription: 'Lists items.\\n\\n' + 'Target patterns:\\n' + '  sentry item list <org>/  # all items in org\\n' } });",
        errors: 1,
      },
      {
        filename: commands,
        code: "buildCommand({ docs: { fullDescription: `Lists items.\\n\\n  sentry item list -c next\\n\\n${note}` } });",
        errors: 1,
      },
    ],
  },
);

tester.run(
  "no-regex-markdown-parsing",
  plugin.rules["no-regex-markdown-parsing"],
  {
    valid: [
      { filename: source, code: "const query = /[^/?#\\s]+/;" },
      { filename: source, code: "const issue = /#(\\d+)/;" },
      {
        filename: "/repo/packages/cli/test/example.test.ts",
        code: "expect(output).toMatch(/^## Usage/m);",
      },
    ],
    invalid: [
      {
        filename: "/repo/packages/cli/script/example.ts",
        code: "const fence = /^(`{3,}|~{3,}).*\\n[\\s\\S]*?\\n\\1\\s*$/gm;",
        errors: 1,
      },
      {
        filename: source,
        code: "const heading = /^#{1,6}\\s+examples?/im;",
        errors: 1,
      },
      {
        filename: "/repo/packages/cli/script/example.ts",
        code: "const heading = new RegExp(`^#{1,4}\\\\s+${name}`, 'im');",
        errors: 1,
      },
    ],
  },
);
