#!/usr/bin/env tsx
/**
 * Generate typed SDK methods from the Stricli command tree.
 *
 * Walks the ENTIRE route tree via introspection, extracts flag definitions
 * and JSON schemas, and generates src/sdk.generated.ts with typed parameter
 * interfaces and method implementations that call invokeCommand() directly.
 *
 * Output is built with the TypeScript compiler's AST factory and printer rather
 * than string templates, so names, string literals, and JSDoc are always escaped.
 * The `SentrySDK` type is built once and emitted into both src/sdk.generated.ts
 * (where the implementation is checked against it) and src/sdk.generated.d.cts
 * (the published declarations), so the two cannot drift apart.
 *
 * Zero manual config — all commands are auto-discovered.
 *
 * Run: tsx script/generate-sdk.ts
 */

import { writeFile } from "node:fs/promises";
import ts from "typescript";
import { routes } from "../src/app.js";
import { extractSchemaFields } from "../src/lib/formatters/output.js";
import {
  type Command,
  type FlagDef,
  isCommand,
  isRouteMap,
  type RouteMap,
} from "../src/lib/introspect.js";
import {
  access,
  f,
  optionalAccess,
  printNodes,
  propertyName,
  stringLiteralUnion,
  typeRef,
  withJsDoc,
} from "./ts-codegen.js";

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

/** Name of the generated type describing the whole SDK method tree. */
const SDK_TYPE_NAME = "SentrySDK";

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
  type: ts.TypeNode;
  optional: boolean;
  brief?: string;
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
  pathPrefix: string[],
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
  type: ts.TypeNode;
  kind: SdkFlagInfo["kind"];
} {
  if (def.kind === "boolean") {
    return {
      type: f.createKeywordTypeNode(ts.SyntaxKind.BooleanKeyword),
      kind: "boolean",
    };
  }

  const stringType = f.createKeywordTypeNode(ts.SyntaxKind.StringKeyword);

  if (def.kind === "enum") {
    const enumDef = def as FlagDef & { values?: readonly string[] };
    return {
      type: enumDef.values ? stringLiteralUnion(enumDef.values) : stringType,
      kind: "enum",
    };
  }

  // kind === "parsed" — infer from default value
  const numberType = f.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword);
  if (def.default !== undefined && typeof def.default === "number") {
    return { type: numberType, kind: "parsed" };
  }
  if (def.default !== undefined && typeof def.default === "string") {
    const numVal = Number(def.default);
    if (!Number.isNaN(numVal) && def.default !== "") {
      return { type: numberType, kind: "parsed" };
    }
  }
  return { type: stringType, kind: "parsed" };
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

    const { type, kind } = inferFlagType(def);
    const optional = def.optional === true || def.default !== undefined;

    flags.push({
      name,
      kind,
      type: def.variadic ? typeRef("Array", [type]) : type,
      optional,
      brief: def.brief,
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

/** Map a single schema field type name to a TypeScript type node. */
function schemaTypeNode(schemaType: string): ts.TypeNode {
  switch (schemaType) {
    case "string":
      return f.createKeywordTypeNode(ts.SyntaxKind.StringKeyword);
    case "number":
      return f.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword);
    case "boolean":
      return f.createKeywordTypeNode(ts.SyntaxKind.BooleanKeyword);
    case "object":
      return typeRef("Record", [
        f.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
        f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
      ]);
    case "array":
      return f.createArrayTypeNode(
        f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
      );
    case "null":
      return f.createLiteralTypeNode(f.createNull());
    default:
      return f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
  }
}

/** Map a schema field type string (possibly a `" | "` union) to a type node. */
function schemaFieldType(schemaType: string): ts.TypeNode {
  const parts = schemaType.split(" | ").map((t) => schemaTypeNode(t.trim()));
  return parts.length === 1 && parts[0]
    ? parts[0]
    : f.createUnionTypeNode(parts);
}

/** `export type Name = { ...members };` */
function exportedObjectType(
  name: string,
  members: ts.TypeElement[],
): ts.TypeAliasDeclaration {
  return f.createTypeAliasDeclaration(
    [f.createModifier(ts.SyntaxKind.ExportKeyword)],
    name,
    undefined,
    f.createTypeLiteralNode(members),
  );
}

/** A property signature (`name?: type;`) with an optional JSDoc. */
function propertySignature(
  name: string,
  optional: boolean,
  type: ts.TypeNode,
  doc?: string,
): ts.PropertySignature {
  return withJsDoc(
    f.createPropertySignature(
      undefined,
      propertyName(name),
      optional ? f.createToken(ts.SyntaxKind.QuestionToken) : undefined,
      type,
    ),
    doc,
  );
}

/**
 * Build the result type from a command's __jsonSchema.
 * Returns null if no schema is attached.
 */
function buildReturnType(
  command: Command,
  typeName: string,
): ts.TypeAliasDeclaration | null {
  const schema = (command as any).__jsonSchema;
  if (!schema) {
    return null;
  }

  const fields = extractSchemaFields(schema);
  if (fields.length === 0) {
    return null;
  }

  return exportedObjectType(
    typeName,
    fields.map((field) =>
      propertySignature(
        field.name,
        field.optional,
        schemaFieldType(field.type),
        field.description,
      ),
    ),
  );
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

/** Build the params type for a command, or null if it takes no named params. */
function buildParamsType(
  typeName: string,
  positional: PositionalInfo,
  flags: SdkFlagInfo[],
): ts.TypeAliasDeclaration | null {
  const members: ts.TypeElement[] = [];

  if (positional && !positional.variadic) {
    for (const entry of positional.entries) {
      members.push(
        propertySignature(
          camelCase(entry.name),
          true,
          f.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
          entry.brief ?? "Positional argument",
        ),
      );
    }
  }

  for (const flag of flags) {
    members.push(
      propertySignature(
        camelCase(flag.name),
        flag.optional,
        flag.type,
        flag.brief,
      ),
    );
  }

  return members.length > 0 ? exportedObjectType(typeName, members) : null;
}

// ---------------------------------------------------------------------------
// SDK Methods
// ---------------------------------------------------------------------------

/** Everything needed to emit one SDK method's signature and implementation. */
type SdkMethod = {
  path: string[];
  brief: string;
  positional: PositionalInfo;
  flags: SdkFlagInfo[];
  /** Flags that switch the command into streaming mode (`AsyncIterable` result). */
  streamingFlags: SdkFlagInfo[];
  /** Name of the params type, when the command has named params. */
  paramsTypeName?: string;
  /** Whether a required flag makes the params object mandatory. */
  paramsRequired: boolean;
  /** Name of the schema-derived result type, or `unknown` when there is none. */
  resultTypeName?: string;
};

/** The method's result type (`FooResult`, or `unknown`). */
function resultType(method: SdkMethod): ts.TypeNode {
  return method.resultTypeName
    ? typeRef(method.resultTypeName)
    : f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
}

/** `...positional: string[]` */
function restPositionalParameter(): ts.ParameterDeclaration {
  return f.createParameterDeclaration(
    undefined,
    f.createToken(ts.SyntaxKind.DotDotDotToken),
    "positional",
    undefined,
    f.createArrayTypeNode(f.createKeywordTypeNode(ts.SyntaxKind.StringKeyword)),
  );
}

/**
 * The method's parameter list: an optional or required params object followed by
 * `...positional` for variadic commands. `paramsType` overrides the params object type,
 * which the streaming overload uses to require its streaming flag.
 */
function methodParameters(
  method: SdkMethod,
  paramsType?: ts.TypeNode,
): ts.ParameterDeclaration[] {
  const parameters: ts.ParameterDeclaration[] = [];
  const type =
    paramsType ??
    (method.paramsTypeName ? typeRef(method.paramsTypeName) : undefined);
  if (type) {
    const optional = !(paramsType || method.paramsRequired);
    parameters.push(
      f.createParameterDeclaration(
        undefined,
        undefined,
        "params",
        optional ? f.createToken(ts.SyntaxKind.QuestionToken) : undefined,
        type,
      ),
    );
  }
  if (method.positional?.variadic) {
    parameters.push(restPositionalParameter());
  }
  return parameters;
}

/**
 * Params type for the streaming overload: the regular params with every streaming
 * flag required (`LogListParams & { follow: string }`).
 */
function streamingParamsType(method: SdkMethod): ts.TypeNode {
  const base = method.paramsTypeName
    ? typeRef(method.paramsTypeName)
    : typeRef("Record", [
        f.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
        f.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword),
      ]);
  const required = f.createTypeLiteralNode(
    method.streamingFlags.map((flag) =>
      propertySignature(camelCase(flag.name), false, flag.type),
    ),
  );
  ts.setEmitFlags(required, ts.EmitFlags.SingleLine);
  return f.createIntersectionTypeNode([base, required]);
}

/**
 * The method's member in the `SentrySDK` type. Streaming commands get two call
 * signatures: passing a streaming flag returns an `AsyncIterable`, otherwise a `Promise`.
 */
function methodTypeMember(method: SdkMethod, name: string): ts.TypeElement {
  const promise = typeRef("Promise", [resultType(method)]);

  if (method.streamingFlags.length === 0) {
    return withJsDoc(
      f.createMethodSignature(
        undefined,
        propertyName(name),
        undefined,
        undefined,
        methodParameters(method),
        promise,
      ),
      method.brief,
    );
  }

  const overloads = f.createTypeLiteralNode([
    f.createCallSignature(
      undefined,
      methodParameters(method, streamingParamsType(method)),
      typeRef("AsyncIterable", [
        f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
      ]),
    ),
    f.createCallSignature(undefined, methodParameters(method), promise),
  ]);
  return propertySignature(name, false, overloads, method.brief);
}

/** The positional-args expression passed to `invoke`. */
function positionalArgs(positional: PositionalInfo): ts.Expression {
  if (!positional) {
    return f.createArrayLiteralExpression([]);
  }
  if (positional.variadic) {
    return f.createIdentifier("positional");
  }
  if (positional.entries.length === 1) {
    const name = camelCase(positional.entries[0]?.name ?? "");
    return f.createConditionalExpression(
      optionalAccess("params", name),
      f.createToken(ts.SyntaxKind.QuestionToken),
      f.createArrayLiteralExpression([access("params", name)]),
      f.createToken(ts.SyntaxKind.ColonToken),
      f.createArrayLiteralExpression([]),
    );
  }
  // Arity matters here, so the values cannot simply be filtered: dropping an omitted
  // entry would shift every later argument into the wrong slot.
  return f.createCallExpression(
    f.createIdentifier("positionals"),
    undefined,
    positional.entries.map((entry) =>
      optionalAccess("params", camelCase(entry.name)),
    ),
  );
}

/** `invoke<Result>(path, flags, positional[, { streaming }])` */
function invokeCall(method: SdkMethod, streaming: boolean): ts.CallExpression {
  const path = f.createArrayLiteralExpression(
    method.path.map((segment) => f.createStringLiteral(segment)),
  );
  const flags = f.createObjectLiteralExpression(
    method.flags.map((flag) =>
      f.createPropertyAssignment(
        propertyName(flag.name),
        optionalAccess("params", camelCase(flag.name)),
      ),
    ),
  );
  const args = [path, flags, positionalArgs(method.positional)];
  if (streaming) {
    args.push(
      f.createObjectLiteralExpression([
        f.createShorthandPropertyAssignment("streaming"),
      ]),
    );
  }
  return f.createCallExpression(
    f.createIdentifier("invoke"),
    [resultType(method)],
    args,
  );
}

/** `SentrySDK["a"]["b"]` — the declared type of the method at `path`. */
function sdkMemberType(path: string[]): ts.TypeNode {
  return path.reduce<ts.TypeNode>(
    (type, segment) =>
      f.createIndexedAccessTypeNode(
        type,
        f.createLiteralTypeNode(f.createStringLiteral(segment)),
      ),
    typeRef(SDK_TYPE_NAME),
  );
}

/**
 * The method's implementation inside `createSDKMethods`.
 *
 * Regular commands narrow the invoker's `Promise | AsyncIterable` union to a `Promise`,
 * since they never pass `meta.streaming`. Streaming commands decide at runtime whether a
 * streaming flag is present; a single arrow cannot express their overloads, so it is
 * asserted to the overloaded type declared in `SentrySDK`.
 */
function methodImplementation(method: SdkMethod): ts.Expression {
  const promise = typeRef("Promise", [resultType(method)]);

  if (method.streamingFlags.length === 0) {
    return f.createArrowFunction(
      undefined,
      undefined,
      methodParameters(method),
      promise,
      undefined,
      f.createAsExpression(invokeCall(method, false), promise),
    );
  }

  const isStreaming = method.streamingFlags
    .map((flag) =>
      f.createStrictInequality(
        optionalAccess("params", camelCase(flag.name)),
        f.createIdentifier("undefined"),
      ),
    )
    .reduce((left, right) => f.createLogicalOr(left, right));

  const body = f.createBlock(
    [
      f.createVariableStatement(
        undefined,
        f.createVariableDeclarationList(
          [
            f.createVariableDeclaration(
              "streaming",
              undefined,
              undefined,
              isStreaming,
            ),
          ],
          ts.NodeFlags.Const,
        ),
      ),
      f.createReturnStatement(invokeCall(method, true)),
    ],
    true,
  );

  const arrow = f.createArrowFunction(
    undefined,
    undefined,
    methodParameters(method),
    undefined,
    undefined,
    body,
  );
  return f.createAsExpression(
    f.createParenthesizedExpression(arrow),
    sdkMemberType(method.path),
  );
}

// ---------------------------------------------------------------------------
// Namespace Tree
// ---------------------------------------------------------------------------

/**
 * A node in the namespace tree. Methods are leaves; children are nested namespaces.
 * Path ["dashboard", "widget", "add"] → root.children["dashboard"].children["widget"].methods["add"]
 */
type NamespaceNode = {
  methods: Map<string, SdkMethod>;
  children: Map<string, NamespaceNode>;
};

function createNamespaceNode(): NamespaceNode {
  return { methods: new Map(), children: new Map() };
}

/** Insert a method into the namespace tree at its route path. */
function insertMethod(tree: NamespaceNode, method: SdkMethod): void {
  const leafName = method.path.at(-1);
  if (!leafName) {
    return;
  }

  let node = tree;
  for (const part of method.path.slice(0, -1)) {
    let child = node.children.get(part);
    if (!child) {
      child = createNamespaceNode();
      node.children.set(part, child);
    }
    node = child;
  }
  node.methods.set(leafName, method);
}

/** Build the `SentrySDK` object type for a namespace node (recursive). */
function namespaceType(node: NamespaceNode): ts.TypeLiteralNode {
  const members: ts.TypeElement[] = [];
  for (const [name, method] of node.methods) {
    members.push(methodTypeMember(method, name));
  }
  for (const [name, child] of node.children) {
    members.push(propertySignature(name, false, namespaceType(child)));
  }
  return f.createTypeLiteralNode(members);
}

/** Build the method-tree object literal for a namespace node (recursive). */
function namespaceObject(node: NamespaceNode): ts.ObjectLiteralExpression {
  const properties: ts.ObjectLiteralElementLike[] = [];
  for (const [name, method] of node.methods) {
    properties.push(
      withJsDoc(
        f.createPropertyAssignment(
          propertyName(name),
          methodImplementation(method),
        ),
        method.brief,
      ),
    );
  }
  for (const [name, child] of node.children) {
    properties.push(
      f.createPropertyAssignment(propertyName(name), namespaceObject(child)),
    );
  }
  return f.createObjectLiteralExpression(properties, true);
}

/**
 * `export function createSDKMethods(invoke: Invoke): SentrySDK { return { ... }; }`
 *
 * The explicit return type makes `tsc` check every generated implementation against the
 * same `SentrySDK` type that is published in the declarations.
 */
function createSdkMethodsFunction(root: NamespaceNode): ts.FunctionDeclaration {
  return withJsDoc(
    f.createFunctionDeclaration(
      [f.createModifier(ts.SyntaxKind.ExportKeyword)],
      undefined,
      "createSDKMethods",
      undefined,
      [
        f.createParameterDeclaration(
          undefined,
          undefined,
          "invoke",
          undefined,
          typeRef("Invoke"),
        ),
      ],
      typeRef(SDK_TYPE_NAME),
      f.createBlock([f.createReturnStatement(namespaceObject(root))], true),
    ),
    "Create the typed SDK method tree. Called by createSentrySDK() with a bound invoker. @internal",
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const allCommands = discoverCommands(routes as unknown as RouteMap, []);
console.log(`Discovered ${allCommands.length} commands`);

const paramTypes: ts.Statement[] = [];
const returnTypes: ts.Statement[] = [];
const sdkTree = createNamespaceNode();

for (const { path, command } of allCommands) {
  const flags = extractSdkFlags(command);
  const positional = derivePositional(command);

  const returnType = buildReturnType(command, `${buildTypeName(path)}Result`);
  if (returnType) {
    returnTypes.push(returnType);
  }

  const params = buildParamsType(
    `${buildTypeName(path)}Params`,
    positional,
    flags,
  );
  if (params) {
    paramTypes.push(params);
  }

  insertMethod(sdkTree, {
    path,
    brief: command.brief || path.join(" "),
    positional,
    flags,
    streamingFlags: flags.filter((flag) => STREAMING_FLAGS.has(flag.name)),
    paramsTypeName: params?.name.text,
    paramsRequired: flags.some((flag) => !flag.optional),
    resultTypeName: returnType?.name.text,
  });
}

const sdkType = exportedObjectType(SDK_TYPE_NAME, [
  ...namespaceType(sdkTree).members,
]);

/** Sections shared verbatim by the implementation file and the published declarations. */
const sharedTypes = [
  "// --- Return types (derived from __jsonSchema) ---",
  "",
  returnTypes.length > 0
    ? printNodes(returnTypes)
    : "// No commands have registered schemas yet.",
  "",
  "// --- Parameter types ---",
  "",
  paramTypes.length > 0
    ? printNodes(paramTypes)
    : "// No commands have parameters.",
  "",
  "// --- SDK type ---",
  "",
  printNodes([sdkType]),
  "",
];

const header = [
  "// Auto-generated by script/generate-sdk.ts — DO NOT EDIT",
  "// Run `pnpm run generate:sdk` to regenerate.",
  "",
];

const output = [
  ...header,
  'import type { buildInvoker } from "./lib/sdk-invoke.js";',
  'import { positionals } from "./lib/sdk-positionals.js";',
  "",
  ...sharedTypes,
  "// --- SDK factory ---",
  "",
  "/** Invoke function type from sdk-invoke.ts */",
  "type Invoke = ReturnType<typeof buildInvoker>;",
  "",
  printNodes([createSdkMethodsFunction(sdkTree)]),
  "",
].join("\n");

const outPath = "./src/sdk.generated.ts";
await writeFile(outPath, output);
console.log(`Generated ${outPath}`);

// Standalone type declarations (.d.cts) for the npm bundle: only the shared type
// exports — no runtime imports or implementations.
const dtsPath = "./src/sdk.generated.d.cts";
await writeFile(dtsPath, [...header, ...sharedTypes].join("\n"));
console.log(`Generated ${dtsPath}`);
