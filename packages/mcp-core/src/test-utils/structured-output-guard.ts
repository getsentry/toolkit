/**
 * Vitest setup file: every tool defined with `defineTool` checks its
 * `structuredContent` against its `outputSchema` whenever a test calls the
 * handler.
 *
 * Tool tests call `tool.handler()` directly, which skips the MCP SDK's own
 * output validation in `tools/call`. With this guard, a tool whose result
 * drifts from its declared schema fails its existing fixture tests instead of
 * failing only for real clients. `server.metadata.test.ts` relies on it; see
 * docs/contributing/tool-responses.md#metadata-linter.
 */
import { vi } from "vitest";

vi.mock("../internal/tool-helpers/define", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../internal/tool-helpers/define")>();
  const defineTool: typeof actual.defineTool = (config) => {
    const { outputSchema } = config;
    if (!outputSchema) {
      return actual.defineTool(config);
    }
    // Mirrors the SDK's output validation in tools/call.
    const handler: typeof config.handler = async (params, context) => {
      const result = await config.handler(params, context);
      if (typeof result === "object" && "isError" in result && result.isError) {
        return result;
      }
      if (typeof result !== "object" || !("structuredContent" in result)) {
        throw new Error(
          `${config.name} has an outputSchema but returned no structuredContent`,
        );
      }
      const parsed = await outputSchema.safeParseAsync(
        result.structuredContent,
      );
      if (!parsed.success) {
        throw new Error(
          `${config.name} returned structuredContent that does not match its outputSchema: ${parsed.error.message}`,
        );
      }
      return result;
    };
    return actual.defineTool({ ...config, handler });
  };
  return { ...actual, defineTool };
});
