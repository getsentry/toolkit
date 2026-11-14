/**
 * The command catalog: what agents need to find and run each command, from
 * the route tree's introspection. Build-time only: `generate:command-catalog`
 * writes it to `@sentry/mcp-core/command-catalog`, and MCP servers read that
 * generated JSON instead of building schemas at runtime.
 *
 * Commands with exposure `hidden` are left out: no MCP server lists them.
 */

import type {
  CommandCatalog,
  CommandCatalogEntry,
  JsonSchema,
} from "@sentry/mcp-core/command-catalog";
import generatedCommandApi from "../generated/command-api.json" with { type: "json" };
import type { ApiReference } from "./api-schema.js";
import type { ApiAccess } from "./command-access.js";
import { CHOICE_TARGET } from "./completion-target.js";
import {
  argumentCompletion,
  buildCommandInfo,
  type Command,
  type FlagDef,
  isCommand,
  type PositionalParam,
  publicTargetPaths,
  type RouteMap,
} from "./introspect.js";

/**
 * Type of one positional or flag value. Only Stricli `enum` flags reject
 * other values; the values of a `choice` parser are suggestions.
 */
function valueSchema(
  def: Pick<FlagDef, "parse" | "placeholder" | "default">,
  enumValues?: readonly string[],
): JsonSchema {
  if (enumValues) {
    return { type: "string", enum: [...enumValues] };
  }
  const { kind, values } = argumentCompletion(def.parse);
  if (kind === CHOICE_TARGET && values) {
    return { type: "string", examples: [...values] };
  }
  // The same inference as the generated SDK's parameter types.
  const numeric =
    def.placeholder === "number" ||
    typeof def.default === "number" ||
    (typeof def.default === "string" &&
      def.default !== "" &&
      !Number.isNaN(Number(def.default)));
  return { type: numeric ? "number" : "string" };
}

/** JSON Schema of one flag. */
function flagSchema(def: FlagDef): JsonSchema {
  const value: JsonSchema =
    def.kind === "boolean"
      ? { type: "boolean" }
      : valueSchema(def, def.kind === "enum" ? def.values : undefined);
  const schema: JsonSchema = def.variadic
    ? { type: "array", items: value }
    : value;
  if (def.brief) schema.description = def.brief;
  if (def.default !== undefined) {
    schema.default =
      value.type === "number" ? Number(def.default) : def.default;
  }
  return schema;
}

/** JSON Schema of one positional. */
function positionalSchema(param: PositionalParam, index: number): JsonSchema {
  return {
    ...valueSchema(param),
    title: param.placeholder ?? `arg${index}`,
    ...(param.brief ? { description: param.brief } : {}),
  };
}

/** JSON Schema of a command's positionals and visible flags. */
function parametersSchema(command: Command): JsonSchema {
  const { positional, flags = {} } = command.parameters;
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  if (positional?.kind === "tuple" && positional.parameters.length > 0) {
    const minItems = positional.parameters.filter((p) => !p.optional).length;
    // `maxItems` rather than `items: false` ends the tuple: VS Code Copilot
    // rejects an array whose `items` is not a schema. `items` only covers
    // positions past `prefixItems`, which `maxItems` rules out.
    properties.positional = {
      type: "array",
      prefixItems: positional.parameters.map(positionalSchema),
      items: { type: "string" },
      ...(minItems > 0 ? { minItems } : {}),
      maxItems: positional.parameters.length,
    };
    if (minItems > 0) required.push("positional");
  } else if (positional?.kind === "array") {
    properties.positional = {
      type: "array",
      items: positionalSchema(positional.parameter, 0),
    };
  }

  const flagProperties: Record<string, JsonSchema> = {};
  const requiredFlags: string[] = [];
  for (const [name, def] of Object.entries(flags)) {
    if (def.hidden) continue;
    flagProperties[name] = flagSchema(def);
    const optional = def.optional ?? def.kind === "boolean";
    if (!optional && def.default === undefined) requiredFlags.push(name);
  }
  if (Object.keys(flagProperties).length > 0) {
    properties.flags = {
      type: "object",
      properties: flagProperties,
      ...(requiredFlags.length > 0 ? { required: requiredFlags } : {}),
      additionalProperties: false,
    };
    if (requiredFlags.length > 0) required.push("flags");
  }

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

/** Completion kinds of a command's positionals and visible flags. */
function completions(command: Command): CommandCatalogEntry["completions"] {
  const { positional, flags = {} } = command.parameters;
  const params =
    positional?.kind === "tuple"
      ? positional.parameters
      : positional
        ? [positional.parameter]
        : [];
  const positionalKinds = params.map(
    (param) => argumentCompletion(param.parse).kind,
  );
  const flagKinds: Record<string, string> = {};
  for (const [name, def] of Object.entries(flags)) {
    if (def.hidden || def.kind === "boolean") continue;
    const { kind } = argumentCompletion(
      def.parse,
      def.kind === "enum" ? def.values : undefined,
    );
    if (kind) flagKinds[name] = kind;
  }
  const result: CommandCatalogEntry["completions"] = {
    ...(positionalKinds.some((kind) => kind !== null)
      ? { positional: positionalKinds }
      : {}),
    ...(Object.keys(flagKinds).length > 0 ? { flags: flagKinds } : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Build the catalog of every command an MCP server may list: each public
 * command whose exposure is not `hidden`, sorted by path.
 *
 * @param routeMap - Top-level Stricli route map
 * @param apiByCommand - API references by command path (`command-api.json`)
 * @param apiAccessByCommand - API request class by command path
 *   (`command-api-access.json`); introspection's import when omitted
 */
export function extractCommandCatalog(
  routeMap: RouteMap,
  apiByCommand: Readonly<
    Record<string, readonly ApiReference[]>
  > = generatedCommandApi,
  apiAccessByCommand?: Readonly<Record<string, ApiAccess>>,
): CommandCatalog {
  const commands: CommandCatalogEntry[] = [];
  for (const [command, segments] of publicTargetPaths(routeMap)) {
    if (!isCommand(command)) continue;
    const info = buildCommandInfo(
      command,
      // oxlint-disable-next-line sentry-cli/no-hardcoded-sentry-command -- a command path, not a hint.
      `sentry ${segments.join(" ")}`,
      apiAccessByCommand,
    );
    const { exposure } = info;
    if (exposure === "hidden") continue;
    const localPathFlags = info.flags
      .filter((flag) => flag.localPath && !flag.hidden)
      .map((flag) => flag.name);
    const completion = completions(command);
    commands.push({
      path: info.path,
      brief: info.brief,
      permission: info.permission,
      exposure,
      parameters: parametersSchema(command),
      ...(completion ? { completions: completion } : {}),
      ...(localPathFlags.length > 0 ? { localPathFlags } : {}),
      examples: info.examples,
      ...(info.jsonFields ? { outputFields: info.jsonFields } : {}),
      apiOperations: [...(apiByCommand[info.path] ?? [])],
    });
  }
  commands.sort((a, b) => a.path.localeCompare(b.path));
  return { commands };
}
