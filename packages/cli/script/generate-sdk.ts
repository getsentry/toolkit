#!/usr/bin/env tsx
/**
 * Generate typed SDK methods from the Stricli command tree.
 *
 * Walks the ENTIRE route tree via introspection, extracts flag definitions
 * and JSON schemas, and generates src/sdk.generated.ts with typed parameter
 * interfaces and method implementations that call invokeCommand() directly.
 *
 * Zero manual config — all commands are auto-discovered.
 *
 * Run: tsx script/generate-sdk.ts
 */

import { writeFile } from "node:fs/promises";
import { routes } from "../src/app.js";
import { extractSchemaFields } from "../src/lib/formatters/output.js";
import {
  type Command,
  type FlagDef,
  isCommand,
  isRouteMap,
  type RouteMap,
} from "../src/lib/introspect.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Flags that are internal to the CLI framework — never exposed as SDK params */
const INTERNAL_FLAGS = new Set([
  "json",
  "web",
  "fresh",
  "compact",
  "log-level",
  "verbose",
  "fields",
]);

/** Flags that trigger streaming mode — included in params but change return type */
const STREAMING_FLAGS = new Set(["refresh", "follow"]);

/** Regex for stripping angle-bracket/ellipsis decorators from placeholder names */
const PLACEHOLDER_CLEAN_RE = /[<>.]/g;

/** Regex to check if a name is a valid unquoted TS identifier */
const VALID_IDENT_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Discovered command with its route path and metadata. */
type DiscoveredCommand = {
  /** Route path segments (e.g., ["org", "list"]) */
  path: string[];
  /** The Stricli command object */
  command: Command;
};

/** Extracted SDK flag info. */
type SdkFlagInfo = {
  name: string;
  kind: "boolean" | "parsed" | "enum";
  tsType: string;
  optional: boolean;
  default?: unknown;
  brief?: string;
  values?: string[];
};

// ---------------------------------------------------------------------------
// Route Tree Walking
// ---------------------------------------------------------------------------

/**
 * Recursively discover all visible commands in the route tree.
 * Skips hidden routes (plural aliases, internal commands).
 */
function discoverCommands(
  target: RouteMap | Command,
  pathPrefix: string[]
): DiscoveredCommand[] {
  if (isCommand(target)) {
    return [{ path: pathPrefix, command: target }];
  }

  if (!isRouteMap(target)) {
    return [];
  }

  const results: DiscoveredCommand[] = [];
  for (const entry of target.getAllEntries()) {
    if (entry.hidden) {
      continue;
    }
    const childPath = [...pathPrefix, entry.name.original];
    results.push(...discoverCommands(entry.target, childPath));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Flag Extraction
// ---------------------------------------------------------------------------

/** Infer the TypeScript type for a single flag definition. */
function inferFlagType(def: FlagDef): {
  tsType: string;
  kind: SdkFlagInfo["kind"];
  values?: string[];
} {
  if (def.kind === "boolean") {
    return { tsType: "boolean", kind: "boolean" };
  }

  if (def.kind === "enum") {
    const enumDef = def as FlagDef & { values?: readonly string[] };
    if (enumDef.values) {
      const values = [...enumDef.values];
      const tsType = values.map((v: string) => `"${v}"`).join(" | ");
      return { tsType, kind: "enum", values };
    }
    return { tsType: "string", kind: "enum" };
  }

  // kind === "parsed" — infer from default value
  if (def.default !== undefined && typeof def.default === "number") {
    return { tsType: "number", kind: "parsed" };
  }
  if (def.default !== undefined && typeof def.default === "string") {
    const numVal = Number(def.default);
    if (!Number.isNaN(numVal) && def.default !== "") {
      return { tsType: "number", kind: "parsed" };
    }
  }
  return { tsType: "string", kind: "parsed" };
}

/** Extract SDK-relevant flag info from a Stricli Command's parameters. */
function extractSdkFlags(command: Command): SdkFlagInfo[] {
  const flagDefs = command.parameters?.flags;
  if (!flagDefs) {
    return [];
  }

  const flags: SdkFlagInfo[] = [];

  for (const [name, def] of Object.entries(flagDefs) as [string, FlagDef][]) {
    if (INTERNAL_FLAGS.has(name)) {
      continue;
    }
    if (def.hidden) {
      continue;
    }

    const { tsType, kind, values } = inferFlagType(def);
    const optional = def.optional === true || def.default !== undefined;

    flags.push({
      name,
      kind,
      tsType: def.variadic ? `Array<${tsType}>` : tsType,
      optional,
      default: def.default,
      brief: def.brief,
      values,
    });
  }

  return flags;
}

// ---------------------------------------------------------------------------
// Positional Handling
// ---------------------------------------------------------------------------

/**
 * Derive positional parameter info from the command's positional placeholder.
 *
 * - No positional → null
 * - Single or compound placeholder → { name, variadic: false }
 * - Variadic (e.g., "<args...>") → { name, variadic: true }
 */
/** One entry of a tuple positional, mapped to its own SDK param. */
type PositionalEntry = { name: string; brief?: string };

type PositionalInfo =
  | null
  | { entries: PositionalEntry[]; variadic: false }
  | { name: string; variadic: true };

function derivePositional(command: Command): PositionalInfo {
  const params = command.parameters?.positional;
  if (!params) {
    return null;
  }

  if (params.kind === "array") {
    const raw = params.parameter.placeholder ?? "args";
    const name = raw.replace(PLACEHOLDER_CLEAN_RE, "");
    return { name, variadic: true };
  }

  if (params.kind === "tuple" && params.parameters.length > 0) {
    // One param per tuple entry. A compound placeholder is a single entry whose own parser
    // splits it ("org/version" → orgVersion), but separate entries are separate argv tokens:
    // joining them into one param made every multi-positional command unusable, because the
    // whole string arrived as argv[0] and the remaining arguments were simply missing.
    const entries = params.parameters.map((p, i) => ({
      name: (p.placeholder ?? `arg${i}`).replace(PLACEHOLDER_CLEAN_RE, ""),
      brief: p.brief,
    }));
    return { entries, variadic: false };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Return Type Generation from __jsonSchema
// ---------------------------------------------------------------------------

/** Map schema field type strings to TypeScript types. */
function mapSchemaType(schemaType: string): string {
  // Handle union types like "string | null"
  if (schemaType.includes(" | ")) {
    return schemaType
      .split(" | ")
      .map((t) => mapSchemaType(t.trim()))
      .join(" | ");
  }
  switch (schemaType) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "Record<string, unknown>";
    case "array":
      return "unknown[]";
    case "null":
      return "null";
    default:
      return "unknown";
  }
}

/** Check if a name needs quoting as a TS property (contains dots, dashes, etc.) */
function needsQuoting(name: string): boolean {
  return !VALID_IDENT_RE.test(name);
}

/** Format a field name as a valid TS property key. */
function formatPropertyName(name: string, opt: string): string {
  if (needsQuoting(name)) {
    return `"${name}"${opt}`;
  }
  return `${name}${opt}`;
}

/**
 * Generate a TypeScript type string from a command's __jsonSchema.
 * Returns null if no schema is attached.
 */
function generateReturnType(
  command: Command,
  typeName: string
): { typeDef: string; typeName: string } | null {
  // biome-ignore lint/suspicious/noExplicitAny: __jsonSchema is a non-standard property
  const schema = (command as any).__jsonSchema;
  if (!schema) {
    return null;
  }

  const fields = extractSchemaFields(schema);
  if (fields.length === 0) {
    return null;
  }

  const fieldLines = fields.map((f) => {
    const opt = f.optional ? "?" : "";
    const desc = f.description ? `  /** ${f.description} */\n` : "";
    const prop = formatPropertyName(f.name, opt);
    return `${desc}  ${prop}: ${mapSchemaType(f.type)};`;
  });

  const typeDef = `export type ${typeName} = {\n${fieldLines.join("\n")}\n};`;
  return { typeDef, typeName };
}

// ---------------------------------------------------------------------------
// Code Generation Helpers
// ---------------------------------------------------------------------------

/** Capitalize a string, converting kebab-case to PascalCase ("auth-token" → "AuthToken"). */
function capitalize(s: string): string {
  return s.replace(/(^|-)([a-z])/g, (_, _sep, c: string) => c.toUpperCase());
}

/** Regex for converting kebab-case to camelCase */
const KEBAB_TO_CAMEL_RE = /-([a-z])/g;

/** Regex for converting slash-separated to camelCase */
const SLASH_TO_CAMEL_RE = /\/([a-z])/g;

function camelCase(s: string): string {
  return s
    .replace(SLASH_TO_CAMEL_RE, (_, c) => c.toUpperCase())
    .replace(KEBAB_TO_CAMEL_RE, (_, c) => c.toUpperCase());
}

/** Build a PascalCase type name from path segments (e.g., ["org", "list"] → "OrgList") */
function buildTypeName(path: string[]): string {
  return path.map(capitalize).join("");
}

/** Generate the params interface for a command. */
function generateParamsInterface(
  path: string[],
  positional: PositionalInfo,
  flags: SdkFlagInfo[]
): { name: string; code: string } | null {
  const lines: string[] = [];

  if (positional && !positional.variadic) {
    for (const entry of positional.entries) {
      lines.push(`  /** ${entry.brief ?? "Positional argument"} */`);
      lines.push(`  ${camelCase(entry.name)}?: string;`);
    }
  }

  for (const flag of flags) {
    const opt = flag.optional ? "?" : "";
    if (flag.brief) {
      lines.push(`  /** ${flag.brief} */`);
    }
    lines.push(`  ${camelCase(flag.name)}${opt}: ${flag.tsType};`);
  }

  if (lines.length === 0) {
    return null;
  }

  const interfaceName = `${buildTypeName(path)}Params`;
  const code = `export type ${interfaceName} = {\n${lines.join("\n")}\n};`;
  return { name: interfaceName, code };
}

/** Build the flag object expression and positional expression for an invoke call. */
function buildInvokeArgs(
  path: string[],
  positional: PositionalInfo,
  flags: SdkFlagInfo[]
): { flagObj: string; positionalExpr: string; pathStr: string } {
  const flagEntries = flags.map((f) => {
    const camel = camelCase(f.name);
    if (f.name !== camel) {
      return `"${f.name}": params?.${camel}`;
    }
    return `${f.name}: params?.${camel}`;
  });

  let positionalExpr = "[]";
  if (positional) {
    if (positional.variadic) {
      positionalExpr = "positional";
    } else if (positional.entries.length === 1) {
      const [entry] = positional.entries;
      const camel = camelCase(entry?.name ?? "");
      positionalExpr = `params?.${camel} ? [params.${camel}] : []`;
    } else {
      // Arity matters here, so the values cannot simply be filtered: dropping an omitted
      // entry would shift every later argument into the wrong slot.
      const args = positional.entries
        .map((entry) => `params?.${camelCase(entry.name)}`)
        .join(", ");
      positionalExpr = `positionals(${args})`;
    }
  }

  const flagObj =
    flagEntries.length > 0 ? `{ ${flagEntries.join(", ")} }` : "{}";
  const pathStr = JSON.stringify(path);

  return { flagObj, positionalExpr, pathStr };
}

/**
 * Generate the method body (invoke call) for a non-streaming command.
 * Uses `as Promise<T>` to narrow the invoke union return type, since
 * non-streaming calls never pass `meta.streaming` and always return a Promise.
 */
function generateMethodBody(
  path: string[],
  positional: PositionalInfo,
  flags: SdkFlagInfo[],
  returnType: string
): string {
  const { flagObj, positionalExpr, pathStr } = buildInvokeArgs(
    path,
    positional,
    flags
  );
  return `invoke<${returnType}>(${pathStr}, ${flagObj}, ${positionalExpr}) as Promise<${returnType}>`;
}

/** Options for generating a streaming method body. */
type StreamingMethodOpts = {
  path: string[];
  positional: PositionalInfo;
  flags: SdkFlagInfo[];
  returnType: string;
  streamingFlagNames: string[];
  indent: string;
};

/**
 * Generate the method body for a streaming-capable command.
 *
 * Detects at runtime whether any streaming flag is present and passes
 * `{ streaming: true }` to the invoker when it is.
 */
function generateStreamingMethodBody(opts: StreamingMethodOpts): string {
  const { flagObj, positionalExpr, pathStr } = buildInvokeArgs(
    opts.path,
    opts.positional,
    opts.flags
  );

  // Build the streaming condition: params?.follow !== undefined || params?.refresh !== undefined
  const conditions = opts.streamingFlagNames
    .map((name) => `params?.${camelCase(name)} !== undefined`)
    .join(" || ");

  const lines = [
    "{",
    `${opts.indent}    const streaming = ${conditions};`,
    `${opts.indent}    return invoke<${opts.returnType}>(${pathStr}, ${flagObj}, ${positionalExpr}, { streaming });`,
    `${opts.indent}  }`,
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Namespace Tree Building
// ---------------------------------------------------------------------------

/**
 * A node in the namespace tree. Leaf nodes have a method implementation,
 * branch nodes contain child namespaces.
 */
type NamespaceNode = {
  methods: Map<string, string>; // method name → generated code
  typeDecls: Map<string, string>; // method name → type declaration
  children: Map<string, NamespaceNode>;
};

function createNamespaceNode(): NamespaceNode {
  return { methods: new Map(), typeDecls: new Map(), children: new Map() };
}

/**
 * Insert a command's method and type declaration into the namespace tree.
 * Path ["org", "list"] → root.children["org"].methods["list"]
 * Path ["dashboard", "widget", "add"] → root.children["dashboard"].children["widget"].methods["add"]
 */
function insertMethod(
  tree: NamespaceNode,
  path: string[],
  methodCode: string,
  typeDecl: string
): void {
  let node = tree;
  const namespaceParts = path.slice(0, -1);
  const leafName = path.at(-1);
  if (!leafName) {
    return;
  }

  for (const part of namespaceParts) {
    let child = node.children.get(part);
    if (!child) {
      child = createNamespaceNode();
      node.children.set(part, child);
    }
    node = child;
  }

  node.methods.set(leafName, methodCode);
  node.typeDecls.set(leafName, typeDecl);
}

/** Render a namespace node as TypeScript code (recursive). */
function renderNamespaceNode(node: NamespaceNode, indent: string): string {
  const parts: string[] = [];

  // Render methods
  for (const [, code] of node.methods) {
    parts.push(code);
  }

  // Render child namespaces
  for (const [name, child] of node.children) {
    const childBody = renderNamespaceNode(child, `${indent}  `);
    const key = needsQuoting(name) ? `"${name}"` : name;
    parts.push(`${indent}${key}: {\n${childBody}\n${indent}},`);
  }

  return parts.join("\n");
}

/** Render a namespace node as a TypeScript type declaration (recursive). */
function renderNamespaceTypeNode(node: NamespaceNode, indent: string): string {
  const parts: string[] = [];

  // Render type declarations for methods
  for (const [, decl] of node.typeDecls) {
    parts.push(decl);
  }

  // Render child namespaces as nested object types
  for (const [name, child] of node.children) {
    const childBody = renderNamespaceTypeNode(child, `${indent}  `);
    const key = needsQuoting(name) ? `"${name}"` : name;
    parts.push(`${indent}${key}: {\n${childBody}\n${indent}};`);
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const allCommands = discoverCommands(routes as unknown as RouteMap, []);
console.log(`Discovered ${allCommands.length} commands`);

const paramInterfaces: string[] = [];
const returnTypes: string[] = [];
const root = createNamespaceNode();

for (const { path, command } of allCommands) {
  const flags = extractSdkFlags(command);
  const positional = derivePositional(command);

  // Detect streaming-capable commands
  const streamingFlagNames = flags
    .filter((f) => STREAMING_FLAGS.has(f.name))
    .map((f) => f.name);
  const isStreaming = streamingFlagNames.length > 0;

  // Generate return type from schema
  const schemaTypeName = `${buildTypeName(path)}Result`;
  const returnTypeInfo = generateReturnType(command, schemaTypeName);
  const returnType = returnTypeInfo ? returnTypeInfo.typeName : "unknown";
  if (returnTypeInfo) {
    returnTypes.push(returnTypeInfo.typeDef);
  }

  // Generate params interface
  const params = generateParamsInterface(path, positional, flags);
  if (params) {
    paramInterfaces.push(params.code);
  }

  // Determine method signature
  const hasRequiredFlags = flags.some((f) => !f.optional);
  const hasVariadicPositional = positional?.variadic === true;

  let paramsArg: string;
  let body: string;

  const brief = command.brief || path.join(" ");
  const rawName = path.at(-1) ?? path[0];
  const methodName = needsQuoting(rawName) ? `"${rawName}"` : rawName;
  const indent = "    ".repeat(path.length - 1);

  if (hasVariadicPositional) {
    // Variadic: (params: XParams, ...positional: string[]) or (params?: XParams, ...positional: string[])
    // Required flags make params required even with variadic positionals
    const paramsOpt = hasRequiredFlags ? "" : "?";
    paramsArg = params
      ? `params${paramsOpt}: ${params.name}, ...positional: string[]`
      : "...positional: string[]";
    body = isStreaming
      ? generateStreamingMethodBody({
          path,
          positional,
          flags,
          returnType,
          streamingFlagNames,
          indent,
        })
      : generateMethodBody(path, positional, flags, returnType);
  } else if (params) {
    const paramsRequired = hasRequiredFlags;
    paramsArg = paramsRequired
      ? `params: ${params.name}`
      : `params?: ${params.name}`;
    body = isStreaming
      ? generateStreamingMethodBody({
          path,
          positional,
          flags,
          returnType,
          streamingFlagNames,
          indent,
        })
      : generateMethodBody(path, positional, flags, returnType);
  } else {
    body = generateMethodBody(path, positional, flags, returnType);
    paramsArg = "";
  }

  const sig = paramsArg ? `(${paramsArg})` : "()";

  let methodCode: string;
  let typeDecl: string;

  if (isStreaming) {
    // Streaming commands use a function body (not arrow expression)
    // because they need runtime streaming detection
    methodCode = [
      `${indent}    /** ${brief} */`,
      `${indent}    ${methodName}: ${sig} => ${body},`,
    ].join("\n");

    // Type declaration: callable interface with overloaded signatures
    const streamingFlagTypes = streamingFlagNames.map((name) => {
      const flag = flags.find((f) => f.name === name);
      return `${camelCase(name)}: ${flag?.tsType ?? "string"}`;
    });
    const streamingConstraint = streamingFlagTypes.join("; ");

    typeDecl = [
      `${indent}    /** ${brief} */`,
      `${indent}    ${methodName}: {`,
      `${indent}      (params: ${params?.name ?? "Record<string, never>"} & { ${streamingConstraint} }): AsyncIterable<unknown>;`,
      `${indent}      ${sig}: Promise<${returnType}>;`,
      `${indent}    };`,
    ].join("\n");
  } else {
    methodCode = [
      `${indent}    /** ${brief} */`,
      `${indent}    ${methodName}: ${sig}: Promise<${returnType}> =>`,
      `${indent}      ${body},`,
    ].join("\n");

    // Type declaration: method signature without implementation
    typeDecl = [
      `${indent}    /** ${brief} */`,
      `${indent}    ${methodName}${sig}: Promise<${returnType}>;`,
    ].join("\n");
  }

  insertMethod(root, path, methodCode, typeDecl);
}

// Build output
const output = [
  "// Auto-generated by script/generate-sdk.ts — DO NOT EDIT",
  "// Run `pnpm run generate:sdk` to regenerate.",
  "",
  'import type { buildInvoker } from "./lib/sdk-invoke.js";',
  "",
  "// --- Return types (derived from __jsonSchema) ---",
  "",
  returnTypes.length > 0
    ? returnTypes.join("\n\n")
    : "// No commands have registered schemas yet.",
  "",
  "// --- Parameter types ---",
  "",
  paramInterfaces.length > 0
    ? paramInterfaces.join("\n\n")
    : "// No commands have parameters.",
  "",
  "// --- SDK factory ---",
  "",
  "/**",
  " * Positional arguments for a command that takes more than one, in declaration order.",
  " *",
  " * Trailing omissions are dropped so optional tail arguments stay optional, but an omission",
  " * in the middle becomes an empty string rather than disappearing - collapsing it would move",
  " * every later argument into the wrong slot and silently run a different command.",
  " */",
  "function positionals(...values: (string | undefined)[]): string[] {",
  "  let end = values.length;",
  "  while (end > 0 && values[end - 1] === undefined) {",
  "    end--;",
  "  }",
  '  return values.slice(0, end).map((value) => value ?? "");',
  "}",
  "",
  "/** Invoke function type from sdk-invoke.ts */",
  "type Invoke = ReturnType<typeof buildInvoker>;",
  "",
  "/**",
  " * Create the typed SDK method tree.",
  " * Called by createSentrySDK() with a bound invoker.",
  " * @internal",
  " */",
  "export function createSDKMethods(invoke: Invoke) {",
  "  return {",
  renderNamespaceNode(root, "    "),
  "  };",
  "}",
  "",
  "/** Return type of createSDKMethods — the typed SDK interface. */",
  "export type SentrySDK = ReturnType<typeof createSDKMethods>;",
  "",
].join("\n");

const outPath = "./src/sdk.generated.ts";
await writeFile(outPath, output);
console.log(`Generated ${outPath}`);

// Build standalone type declarations (.d.cts) for the npm bundle.
// Contains only type exports — no runtime imports or implementations.
const dtsOutput = [
  "// Auto-generated by script/generate-sdk.ts — DO NOT EDIT",
  "// Run `pnpm run generate:sdk` to regenerate.",
  "",
  "// --- Return types (derived from __jsonSchema) ---",
  "",
  returnTypes.length > 0
    ? returnTypes.join("\n\n")
    : "// No commands have registered schemas yet.",
  "",
  "// --- Parameter types ---",
  "",
  paramInterfaces.length > 0
    ? paramInterfaces.join("\n\n")
    : "// No commands have parameters.",
  "",
  "// --- SDK type ---",
  "",
  `export type SentrySDK = {\n${renderNamespaceTypeNode(root, "  ")}\n};`,
  "",
].join("\n");

const dtsPath = "./src/sdk.generated.d.cts";
await writeFile(dtsPath, dtsOutput);
console.log(`Generated ${dtsPath}`);
