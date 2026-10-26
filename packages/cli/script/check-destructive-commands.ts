#!/usr/bin/env tsx
/**
 * Commands that send an HTTP DELETE must be marked destructive.
 *
 * The agent Safety Rules list destructive commands from command metadata
 * (`buildDeleteCommand`, or `buildCommand({ destructive: true })`). This check
 * derives the commands that can delete something from the code instead of
 * trusting that metadata:
 *
 *   1. DELETE operations come from the `@sentry/api` SDK itself (operations
 *      built on `client.delete(...)`), plus raw requests with
 *      `method: "DELETE"`.
 *   2. A function in `src/` that calls one, directly or through other
 *      functions, imports, and barrel re-exports, deletes too.
 *   3. A command module that uses a deleting function must be built with
 *      `buildDeleteCommand` or pass `destructive: true`.
 *
 * Only DELETE is inferred. POST and PUT also create, update, and restore, so
 * irreversible non-DELETE operations (`issue merge`, `trial start`) keep an
 * explicit `destructive: true`.
 *
 * Usage:
 *   tsx script/check-destructive-commands.ts
 *
 * Exit codes:
 *   0 - Every command that can send a DELETE is marked destructive
 *   1 - A command sends a DELETE but is not marked destructive
 */

import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { glob } from "tinyglobby";
import ts from "typescript";

/** `var deleteProject = (options) => (options.client ?? client).delete({` */
const SDK_DELETE_OP_RE =
  /\bvar (\w+) = \(options\) => \(options\.client \?\? client\)\.delete\(/g;

const SDK_MODULE = "@sentry/api";

/** Where a local name comes from: a module path (or the SDK) and its export. */
type Binding = { module: string; name: string };

type Module = {
  /** Import bindings: local name → source. */
  imports: Map<string, Binding>;
  /** `export { a as b } from "./x.js"`: exported name → source. */
  reExports: Map<string, Binding>;
  /** `export * from "./x.js"` targets. */
  starExports: string[];
  /** Top-level functions: name → identifiers they reference. */
  functions: Map<string, Set<string>>;
  /** Top-level functions that issue a raw `method: "DELETE"` request. */
  rawDelete: Set<string>;
  /** Every identifier in the file. */
  identifiers: Set<string>;
  /** Built with `buildDeleteCommand` or `destructive: true`. */
  markedDestructive: boolean;
};

async function loadSdkDeleteOps(): Promise<Set<string>> {
  const entry = fileURLToPath(import.meta.resolve(SDK_MODULE));
  const source = await readFile(entry, "utf-8");
  const ops = new Set([...source.matchAll(SDK_DELETE_OP_RE)].map((m) => m[1]));
  if (ops.size === 0) {
    throw new Error(
      `No DELETE operations found in ${entry}; the SDK build format changed. Update SDK_DELETE_OP_RE.`,
    );
  }
  return ops as Set<string>;
}

function resolveSpecifier(file: string, specifier: string): string | null {
  if (specifier === SDK_MODULE) {
    return SDK_MODULE;
  }
  if (!specifier.startsWith(".")) {
    return null;
  }
  return relative(
    process.cwd(),
    resolve(dirname(file), specifier.replace(/\.js$/, ".ts")),
  );
}

function collectIdentifiers(node: ts.Node, into: Set<string>): void {
  if (ts.isIdentifier(node)) {
    into.add(node.text);
  }
  node.forEachChild((child) => collectIdentifiers(child, into));
}

function hasRawDelete(node: ts.Node): boolean {
  if (
    ts.isPropertyAssignment(node) &&
    node.name.getText() === "method" &&
    ts.isStringLiteral(node.initializer) &&
    node.initializer.text === "DELETE"
  ) {
    return true;
  }
  return node.forEachChild(hasRawDelete) ?? false;
}

function isMarkedDestructive(node: ts.Node): boolean {
  if (
    ts.isCallExpression(node) &&
    node.expression.getText() === "buildDeleteCommand"
  ) {
    return true;
  }
  if (
    ts.isPropertyAssignment(node) &&
    node.name.getText() === "destructive" &&
    node.initializer.kind === ts.SyntaxKind.TrueKeyword
  ) {
    return true;
  }
  return node.forEachChild(isMarkedDestructive) ?? false;
}

/** Name and body of a top-level function declaration or `const f = () => …`. */
function topLevelFunctions(statement: ts.Statement): [string, ts.Node][] {
  if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
    return [[statement.name.text, statement.body]];
  }
  if (!ts.isVariableStatement(statement)) {
    return [];
  }
  return statement.declarationList.declarations.flatMap(
    (d): [string, ts.Node][] =>
      ts.isIdentifier(d.name) &&
      d.initializer &&
      (ts.isArrowFunction(d.initializer) ||
        ts.isFunctionExpression(d.initializer))
        ? [[d.name.text, d.initializer]]
        : [],
  );
}

function parseModule(file: string, source: string): Module {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const mod: Module = {
    imports: new Map(),
    reExports: new Map(),
    starExports: [],
    functions: new Map(),
    rawDelete: new Set(),
    identifiers: new Set(),
    markedDestructive: isMarkedDestructive(sf),
  };
  collectIdentifiers(sf, mod.identifiers);

  for (const statement of sf.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const module = resolveSpecifier(file, statement.moduleSpecifier.text);
      const bindings = statement.importClause?.namedBindings;
      if (module && bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          const name = (el.propertyName ?? el.name).text;
          mod.imports.set(el.name.text, { module, name });
        }
      }
      continue;
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const module = resolveSpecifier(file, statement.moduleSpecifier.text);
      if (!module) {
        continue;
      }
      const clause = statement.exportClause;
      if (!clause) {
        mod.starExports.push(module);
      } else if (ts.isNamedExports(clause)) {
        for (const el of clause.elements) {
          const name = (el.propertyName ?? el.name).text;
          mod.reExports.set(el.name.text, { module, name });
        }
      }
      continue;
    }
    for (const [name, body] of topLevelFunctions(statement)) {
      const refs = new Set<string>();
      collectIdentifiers(body, refs);
      mod.functions.set(name, refs);
      if (hasRawDelete(body)) {
        mod.rawDelete.add(name);
      }
    }
  }
  return mod;
}

const sdkDeleteOps = await loadSdkDeleteOps();
const files = await glob("src/**/*.ts", {
  ignore: ["src/generated/**", "**/*.test.ts"],
});
const modules = new Map<string, Module>();
for (const file of files) {
  modules.set(file, parseModule(file, await readFile(file, "utf-8")));
}

/** `file#name` → a human-readable chain ending at the DELETE. */
const deleting = new Map<string, string>();

/** Whether `name` exported from `module` deletes; returns its chain. */
function exportDeletes(
  module: string,
  name: string,
  seen = new Set<string>(),
): string | undefined {
  if (module === SDK_MODULE) {
    return sdkDeleteOps.has(name) ? `${SDK_MODULE} ${name}` : undefined;
  }
  const key = `${module}#${name}`;
  if (deleting.has(key)) {
    return deleting.get(key);
  }
  const mod = modules.get(module);
  if (!mod || seen.has(key)) {
    return;
  }
  seen.add(key);
  const reExport = mod.reExports.get(name);
  if (reExport) {
    return exportDeletes(reExport.module, reExport.name, seen);
  }
  for (const target of mod.starExports) {
    const chain = exportDeletes(target, name, seen);
    if (chain) {
      return chain;
    }
  }
  return;
}

/** Whether identifier `ref` used in `file` refers to something that deletes. */
function refDeletes(
  file: string,
  mod: Module,
  ref: string,
): string | undefined {
  const local = deleting.get(`${file}#${ref}`);
  if (local) {
    return local;
  }
  const binding = mod.imports.get(ref);
  return binding ? exportDeletes(binding.module, binding.name) : undefined;
}

// Fixed point: propagate "deletes" through calls until nothing changes.
let changed = true;
while (changed) {
  changed = false;
  for (const [file, mod] of modules) {
    for (const [name, refs] of mod.functions) {
      const key = `${file}#${name}`;
      if (deleting.has(key)) {
        continue;
      }
      if (mod.rawDelete.has(name)) {
        deleting.set(key, `${key} (method: "DELETE")`);
        changed = true;
        continue;
      }
      for (const ref of refs) {
        const chain = ref === name ? undefined : refDeletes(file, mod, ref);
        if (chain) {
          deleting.set(key, `${key} → ${chain}`);
          changed = true;
          break;
        }
      }
    }
  }
}

const problems: string[] = [];
let deletingCommands = 0;
for (const [file, mod] of modules) {
  if (!file.startsWith("src/commands/")) {
    continue;
  }
  let chain: string | undefined;
  for (const ref of mod.identifiers) {
    chain = refDeletes(file, mod, ref);
    if (chain) {
      break;
    }
  }
  if (!chain) {
    continue;
  }
  deletingCommands += 1;
  if (!mod.markedDestructive) {
    problems.push(`${file} sends a DELETE via ${chain}`);
  }
}

if (problems.length === 0) {
  console.log(
    `✓ All ${deletingCommands} command module(s) that send a DELETE are marked destructive`,
  );
  process.exit(0);
}

console.error(
  `✗ ${problems.length} command(s) send a DELETE but are not marked destructive:\n`,
);
for (const problem of problems) {
  console.error(`  ${problem}`);
}
console.error(
  "\n  Build them with buildDeleteCommand, or pass `destructive: true` to buildCommand.",
);
process.exit(1);
