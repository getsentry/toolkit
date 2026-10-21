import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { UserInputError } from "../../errors";
import {
  getConstraintKeysToFilter,
  getConstraintParametersToInject,
} from "../../internal/constraint-helpers";
import { type Skill, isEnabledBySkills } from "../../skills";
import type { ProjectCapabilities, ServerContext } from "../../types";
import {
  isCatalogInfrastructureToolName,
  isOutsideCatalogToolName,
  isTopLevelToolName,
} from "../surfaces";
import {
  type ToolConfig,
  type DescriptionContext,
  isToolVisibleInMode,
  resolveDescription,
} from "../types";

export type ToolRegistry = Record<string, ToolConfig<any>>;

export interface ToolWithContext {
  key: string;
  tool: ToolConfig<any>;
  isCatalogTool: boolean;
  isTopLevel: boolean;
}

export interface CatalogContext {
  context: ServerContext;
  experimentalMode: boolean;
  useDefaultSurfacePolicy: boolean;
}

function getToolPlacement({
  key,
  experimentalMode,
  useDefaultSurfacePolicy,
}: {
  key: string;
  experimentalMode: boolean;
  useDefaultSurfacePolicy: boolean;
}): {
  isCatalogTool: boolean;
  isTopLevel: boolean;
} {
  if (useDefaultSurfacePolicy) {
    return {
      isCatalogTool: !isOutsideCatalogToolName(key),
      isTopLevel: isTopLevelToolName(key, experimentalMode),
    };
  }

  // Custom registries are direct by default so existing tests and local mocks
  // do not need a central surface assignment.
  return { isCatalogTool: true, isTopLevel: true };
}

function hasRequiredCapabilities({
  tool,
  context,
}: {
  tool: ToolConfig<any>;
  context: ServerContext;
}): boolean {
  if (
    !context.constraints.projectSlug ||
    !context.constraints.projectCapabilities ||
    !tool.requiredCapabilities?.length
  ) {
    return true;
  }

  const caps = context.constraints.projectCapabilities;
  return tool.requiredCapabilities.every(
    (cap: keyof ProjectCapabilities) => caps[cap] === true,
  );
}

function isAllowedBySkills({
  tool,
  context,
}: {
  tool: ToolConfig<any>;
  context: ServerContext;
}): boolean {
  const grantedSkills: Set<Skill> | undefined = context.grantedSkills
    ? new Set<Skill>(context.grantedSkills)
    : undefined;

  if (!grantedSkills) {
    return false;
  }

  return (
    tool.skills.length > 0 && isEnabledBySkills(grantedSkills, tool.skills)
  );
}

function isHiddenByConstraints({
  key,
  context,
}: {
  key: string;
  context: ServerContext;
}): boolean {
  return (
    (key === "find_organizations" && !!context.constraints.organizationSlug) ||
    (key === "find_projects" && !!context.constraints.projectSlug) ||
    (key === "create_project" && !!context.constraints.projectSlug)
  );
}

export function getFilteredInputSchema(
  tool: ToolConfig<any>,
  context: ServerContext,
): Record<string, z.ZodType> {
  const constraintKeysToFilter = new Set(
    getConstraintKeysToFilter(context.constraints, tool.inputSchema),
  );

  return Object.fromEntries(
    Object.entries(tool.inputSchema).filter(
      ([key]) => !constraintKeysToFilter.has(key),
    ),
  ) as Record<string, z.ZodType>;
}

export function injectConstraintParams(
  params: Record<string, unknown>,
  tool: ToolConfig<any>,
  context: ServerContext,
): Record<string, unknown> {
  return {
    ...params,
    ...getConstraintParametersToInject(context.constraints, tool.inputSchema),
  };
}

export function getAvailableTools({
  tools,
  context,
  experimentalMode,
  useDefaultSurfacePolicy,
}: CatalogContext & {
  tools: ToolRegistry;
}): ToolWithContext[] {
  const availableTools: ToolWithContext[] = [];

  for (const [key, tool] of Object.entries(tools)) {
    const placement = getToolPlacement({
      key,
      experimentalMode,
      useDefaultSurfacePolicy,
    });

    if (!placement.isCatalogTool && !placement.isTopLevel) {
      continue;
    }

    if (!isToolVisibleInMode(tool, experimentalMode)) {
      continue;
    }

    if (!isAllowedBySkills({ tool, context })) {
      continue;
    }

    if (isHiddenByConstraints({ key, context })) {
      continue;
    }

    if (!hasRequiredCapabilities({ tool, context })) {
      continue;
    }

    availableTools.push({ key, tool, ...placement });
  }

  return availableTools;
}

export function getToolsForMcpRegistration({
  tools,
  context,
  experimentalMode,
  useDefaultSurfacePolicy,
}: CatalogContext & {
  tools: ToolRegistry;
}): ToolWithContext[] {
  const availableTools = getAvailableTools({
    tools,
    context,
    experimentalMode,
    useDefaultSurfacePolicy,
  });

  return availableTools.filter(({ isTopLevel }) => isTopLevel);
}

export function getSearchableTools({
  tools,
  context,
  experimentalMode,
  useDefaultSurfacePolicy,
}: CatalogContext & {
  tools: ToolRegistry;
}): ToolWithContext[] {
  return getAvailableTools({
    tools,
    context,
    experimentalMode,
    useDefaultSurfacePolicy,
  }).filter(
    ({ key, isCatalogTool }) =>
      isCatalogTool && !isCatalogInfrastructureToolName(key),
  );
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "arguments";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

export async function executeToolHandler({
  tool,
  params,
  context,
}: {
  tool: ToolConfig<any>;
  params: Record<string, unknown>;
  context: ServerContext;
}) {
  const paramsWithConstraints = prepareToolParams({ tool, params, context });

  return await tool.handler(paramsWithConstraints as never, context);
}

export function prepareToolParams({
  tool,
  params,
  context,
}: {
  tool: ToolConfig<any>;
  params: Record<string, unknown>;
  context: ServerContext;
}): Record<string, unknown> {
  const filteredInputSchema = getFilteredInputSchema(tool, context);
  const schema = z.object(filteredInputSchema);
  const parsed = schema.safeParse(params);

  if (!parsed.success) {
    throw new UserInputError(
      `Invalid arguments for ${tool.name}: ${formatZodIssues(parsed.error)}`,
    );
  }

  return injectConstraintParams(parsed.data, tool, context);
}

export function resolveToolDescription(
  tool: ToolConfig<any>,
  context: DescriptionContext,
): string {
  return resolveDescription(tool.description, context);
}

export type RegisteredToolHandlerExtra = RequestHandlerExtra<
  ServerRequest,
  ServerNotification
>;
