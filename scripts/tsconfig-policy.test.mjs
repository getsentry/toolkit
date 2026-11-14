import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import ts from "@typescript/typescript6";
import {
  checkedPrograms,
  libCheckException,
  policyOptions,
  ROOT,
  trackedTypeScriptFiles,
  workspacePackages,
} from "./tsconfig-policy.mjs";

/**
 * Tracked TypeScript files that no type check covers on purpose. Each entry
 * must still match a file.
 */
const UNCHECKED = [
  {
    pattern: /^packages\/codemod-cli3to4\/tests\//,
    reason:
      "codemod input and expected-output fixtures, compared as text by `jssg test`",
  },
  {
    pattern: /^packages\/logger\/test\/package\/consumer\//,
    reason:
      "packed-package consumer, compiled against the tarball by test/package/check.sh",
  },
  {
    pattern: /^packages\/mcp-cloudflare\/worker-configuration\.d\.ts$/,
    reason:
      "`wrangler types` output that no program references; Env comes from src/server/types.ts",
  },
];

const programs = checkedPrograms();
const policy = policyOptions();
/**
 * Runtime defaults in tsconfig.base.json that projects may override. Every
 * other option there is checking policy.
 */
const RUNTIME_KEYS = new Set([
  "target",
  "module",
  "moduleResolution",
  "esModuleInterop",
  "resolveJsonModule",
]);
const policyKeys = Object.keys(
  ts.readConfigFile(join(ROOT, "tsconfig.base.json"), ts.sys.readFile).config
    .compilerOptions,
).filter((key) => !RUNTIME_KEYS.has(key));

test("every package with a tsconfig.json has a typecheck script", () => {
  for (const packageDir of workspacePackages()) {
    if (!existsSync(join(packageDir, "tsconfig.json"))) {
      continue;
    }
    const { name, scripts = {} } = JSON.parse(
      readFileSync(join(packageDir, "package.json"), "utf8"),
    );
    assert.ok(scripts.typecheck, `${name} has no "typecheck" script`);
  }
});

test("every type check runs a program with files", () => {
  assert.ok(programs.size > 0);
  for (const [config, { files }] of programs) {
    assert.ok(files.length > 0, `${config} checks no files`);
  }
});

test("no checked program weakens the shared compiler policy", () => {
  for (const [config, { options }] of programs) {
    for (const key of policyKeys) {
      if (key === "skipLibCheck") {
        continue;
      }
      assert.equal(
        options[key] ?? false,
        policy[key],
        `${config} overrides ${key}; the shared policy sets ${JSON.stringify(policy[key])}`,
      );
    }
  }
});

test("every skipLibCheck exception gives its reasons", () => {
  for (const [config, { path, options }] of programs) {
    if (options.skipLibCheck !== true) {
      continue;
    }
    const exception = libCheckException(path);
    assert.ok(exception, `${config} skips library checks without an exception`);
    assert.ok(
      exception.reasons.length > 0,
      `${exception.config} sets skipLibCheck without a "// skipLibCheck exception: <dependency> <diagnostic>. Remove when <condition>." comment`,
    );
    for (const reason of exception.reasons) {
      assert.match(
        reason,
        /Remove when .+\.$/,
        `${exception.config}: "${reason}" names no removal condition`,
      );
    }
  }
});

test("every tracked TypeScript file is in a checked program", () => {
  const checked = new Set([...programs.values()].flatMap(({ files }) => files));
  const files = trackedTypeScriptFiles();
  const missing = files.filter(
    (file) =>
      !checked.has(file) &&
      !UNCHECKED.some(({ pattern }) => pattern.test(file)),
  );
  assert.deepEqual(missing, [], "add these files to a checked tsconfig");
  for (const { pattern } of UNCHECKED) {
    assert.ok(
      files.some((file) => pattern.test(file)),
      `${pattern.source} matches no tracked file`,
    );
  }
});
