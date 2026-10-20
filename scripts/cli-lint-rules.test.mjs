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
