import { z } from "zod";

export const CODE_MODE_SKILLS = ["api-read", "api-write"] as const;

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
  authorizationRequired,
}: {
  allowWrites: boolean;
  authorizationRequired: boolean;
}) {
  return {
    search_sentry_api: {
      title: "Search Sentry API",
      description: `Discover Sentry HTTP API operations by executing a JavaScript async arrow function against the global spec. The configured OpenAPI document has schemas inline; no $ref resolution is needed. No network or API calls are available.
Search using the user's product terms across operation metadata: paths may use different internal names. Each spec.paths[path] has optional path-level parameters and HTTP-method operations. Operations have optional operationId, summary, description, tags (string[]), parameters, requestBody and responses. spec.tags, when present, describes categories with name, description and optional x-sidebar-name.
First return a short list of matching methods, paths and summaries. If results are empty or unrelated, inspect categories and broaden the terms before trying API routes. Then inspect the selected operation's descriptions, parameters, requestBody and relevant response fields. Path-level parameters also apply; operation parameters override them by name and in. Do not return whole paths, the full spec or sliced JSON strings. Return only needed fields; the result limit is 50,000 bytes.
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
      description: `Execute a JavaScript async arrow function with sentry.request({method?, path, query?, body?}). Discover endpoints and schemas with search_sentry_api. method defaults to GET. path is relative to the configured API prefix; full /api/0 paths are also accepted. query accepts string, number or boolean values and arrays of those values; arrays produce repeated parameters, and null/undefined values are omitted. body is JSON. Each request returns {status, headers, body}; headers.link preserves pagination. Non-2xx responses throw an Error with status, method, path, headers, data. On 403, headers["www-authenticate"] may provide insufficient_scope evidence; a denial without that evidence does not identify its cause. Credentials are injected outside the sandbox. Direct network access is disabled; use sentry.request for HTTP.${authorizationRequired ? " Only documented operations within this connection’s API read/write permission and organization constraint are allowed. Sentry separately enforces the upstream token scopes and user/resource permissions. A permission denial cannot be bypassed by changing routes or using fetch directly." : ""}
Before writing, discover the operation and inspect its request contract, defaults and update semantics. For edits, read the current resource through HTTP: other MCP tools may return renamed, enriched or filtered views. Even a raw GET response is not a write template: sending the same field and value back can trigger effects, including propagating an aggregate value to child resources. Build the body explicitly from required fields and requested changes. Include other fields only when the request contract or documented update behavior requires them; do not resend unchanged optional fields merely because GET returned them. Do not assume PUT replaces everything or that omitted fields always stay unchanged, and do not turn a missing field into an empty list or null. When the contract requires resending nested collections, retain existing IDs, values and relationships unless the user requested changing them. If preservation is ambiguous, obtain more documentation or report the limitation rather than inventing write semantics. Re-read after a write to verify requested changes and preserved settings. If an unexpected side effect occurs, do not probe speculative write bodies or routes to repair it; report the actual state unless a documented repair is available.
Combine dependent requests, loops, pagination and verification in code. Keep intermediate responses inside the program and return only the fields needed to answer the user, such as IDs, URLs, counts or a concise verification result. Return full objects only when the user needs their full contents.
Limits: 20 API calls, 30 seconds, 50,000 output bytes, 2 MB per API response. Writes are ${allowWrites ? "enabled" : "disabled"}. No automatic retries. Execution is not atomic; inspect state before retrying a failed write.
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
  Object.keys(
    getCodeModeToolDefinitions({
      allowWrites: false,
      authorizationRequired: true,
    }),
  ),
);
