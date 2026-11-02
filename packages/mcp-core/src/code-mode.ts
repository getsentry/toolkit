/**
 * Hosted Code Mode tool definitions. The runtime lives in
 * `packages/mcp-cloudflare/src/code-mode/` because it needs Dynamic Workers;
 * the definitions live here so definition generation, `/.mcp/tools.json` and
 * the consent screen read them like any other tool metadata.
 */
import { z } from "zod";
import type { Skill } from "./skills";

/**
 * Skills that grant Code Mode. Listed explicitly, so a new hosted-only skill
 * never grants arbitrary API access by itself; each must be `hostedOnly`.
 */
export const CODE_MODE_SKILLS = [
  "api-read",
  "api-write",
] as const satisfies readonly Skill[];

export function isCodeModeSkill(skill: string): boolean {
  return CODE_MODE_SKILLS.some((codeModeSkill) => codeModeSkill === skill);
}

export const codeModeResultSchema = z
  .object({
    result: z.unknown().optional(),
    error: z.string().optional(),
    httpError: z
      .object({
        status: z.number(),
        method: z.string(),
        path: z.string(),
        headers: z.record(z.string(), z.string()),
      })
      .optional(),
    stats: z.object({ apiCalls: z.number(), writesAttempted: z.number() }),
  })
  .refine(
    (value) => "result" in value !== "error" in value,
    "Return either a result or an error.",
  );

/** Shared by hosted registration, public metadata and plugin generation. */
export function getCodeModeToolDefinitions({
  allowWrites,
}: {
  allowWrites: boolean;
}) {
  return {
    search_sentry_api: {
      title: "Search Sentry API",
      description: `Discover Sentry HTTP API operations by running a JavaScript async arrow function against the global spec, an OpenAPI document with schemas inline (no $ref). No network or API calls are available.
Search the user's terms across paths, operationId, summary, description and tags; paths may use internal names. spec.paths[path] holds optional path-level parameters and one operation per HTTP method, with parameters, requestBody and responses. spec.tags lists categories.
First return a short list of matching methods, paths and summaries. If nothing fits, inspect categories and broaden the terms before guessing routes. Then inspect the chosen operation's description, parameters (they override path-level ones by name and in), requestBody and needed response fields. Return only needed fields, not the full spec or sliced JSON; the limit is 50,000 bytes.
Discovery example: async () => {
  const term = "release";
  const results = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!["get", "post", "put", "patch", "delete", "head", "options", "trace"].includes(method)) continue;
      const text = [path, op.operationId, op.summary, op.description, ...(op.tags ?? [])].join(" ").toLowerCase();
      if (text.includes(term.toLowerCase())) results.push({method, path, operationId: op.operationId, summary: op.summary, tags: op.tags});
    }
  }
  return results;
}
Categories example: async () => spec.tags?.length ? spec.tags : [...new Set(Object.values(spec.paths).flatMap(item => Object.entries(item).filter(([method]) => ["get", "post", "put", "patch", "delete", "head", "options", "trace"].includes(method)).flatMap(([, op]) => op.tags ?? [])))].map(name => ({name}))
Schema example: async () => { const path = "/api/0/organizations/{organization_id_or_slug}/releases/"; const item = spec.paths[path]; const op = item.post; return {description: op.description, pathParameters: item.parameters, operationParameters: op.parameters, requestBody: op.requestBody}; }`,
      inputSchema: z.object({
        code: z
          .string()
          .min(1)
          .max(30_000)
          .describe(
            "JavaScript async arrow function, e.g. async () => Object.keys(spec.paths)",
          ),
      }),
      outputSchema: codeModeResultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    execute_sentry_code: {
      title: "Execute Sentry API code",
      description: `Execute a JavaScript async arrow function with sentry.request({method?, path, query?, body?}); find operations with search_sentry_api. method defaults to GET; path is relative to /api/0 (full paths work); query values may be arrays (repeated); null/undefined are omitted; body is JSON. Requests return {status, headers, body}; headers.link paginates. Non-2xx responses throw an Error with status, method, path, headers and data; on 403, headers["www-authenticate"] may show insufficient_scope, otherwise the cause is unknown.
Credentials stay outside the sandbox; fetch is disabled. Only documented operations within this connection's API permission and organization are allowed, and Sentry still enforces the token's scopes and the user's permissions; other routes cannot bypass a denial.
Before writing, read the operation's request contract and update semantics, and read the current resource over HTTP: other MCP tools return transformed views. A GET response is not a write template; resending a value can change child resources. Send required fields and the requested changes, not unchanged optional fields. Do not assume PUT replaces everything or that omitted fields stay unchanged, and never turn a missing field into an empty list or null. When nested collections must be resent, keep their IDs, values and relationships. If preservation is unclear, read more documentation or report it. Re-read to verify writes; after an unexpected side effect, report the state instead of attempting speculative repairs.
Combine dependent requests, pagination and verification in one program, await every sentry.request() before returning, and return only the fields the user needs.
Limits: 20 API calls, 30 seconds, 50,000 output bytes, 2 MB per response. Writes are ${allowWrites ? "enabled" : "disabled"}. No retries and no rollback: inspect state before retrying a write.
Example: async () => { const response = await sentry.request({path: "/organizations/"}); return {organizations: response.body.map(({slug, name}) => ({slug, name})), pagination: response.headers.link}; }`,
      inputSchema: z.object({
        code: z
          .string()
          .min(1)
          .max(30_000)
          .describe("JavaScript async arrow function using sentry.request"),
      }),
      outputSchema: codeModeResultSchema,
      annotations: {
        readOnlyHint: !allowWrites,
        destructiveHint: allowWrites,
        openWorldHint: true,
      },
    },
  };
}

export const CODE_MODE_TOOL_NAMES: readonly string[] = Object.freeze(
  Object.keys(getCodeModeToolDefinitions({ allowWrites: false })),
);
