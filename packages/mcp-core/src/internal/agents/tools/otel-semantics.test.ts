import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logging", () => ({
  logIssue: vi.fn(),
}));

// Import the actual function - no mocking needed since build runs first
import { lookupOtelSemantics } from "./otel-semantics";

describe("otel-semantics-lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("lookupOtelSemantics", () => {
    it("should return namespace information for valid namespace", async () => {
      const result = await lookupOtelSemantics("gen_ai");

      expect(result).toContain("# OpenTelemetry Semantic Conventions: gen_ai");
      expect(result).toContain("## Attributes");
      expect(result).toContain("`gen_ai.usage.input_tokens`");
      expect(result).toContain("`gen_ai.usage.output_tokens`");
      expect(result).toContain("- **Type:**");
      expect(result).toContain("- **Description:**");
    });

    it("should handle namespace with underscore and dash interchangeably", async () => {
      const result1 = await lookupOtelSemantics("gen_ai");
      const result2 = await lookupOtelSemantics("gen-ai");

      expect(result1).toBe(result2);
    });

    it("should return all attributes for a namespace", async () => {
      const result = await lookupOtelSemantics("http");

      expect(result).toContain("total)");
      expect(result).toContain("`http.request.method`");
      expect(result).toContain("`http.response.status_code`");
    });

    it("should return MCP semantic attributes", async () => {
      const result = await lookupOtelSemantics("mcp");

      expect(result).toContain("# OpenTelemetry Semantic Conventions: mcp");
      expect(result).toContain("`mcp.method.name`");
      expect(result).toContain("`mcp.protocol.version`");
      expect(result).toContain("`mcp.resource.uri`");
      expect(result).toContain("`mcp.session.id`");
      expect(result).not.toContain("**Note:** This is a custom namespace");
    });

    it("should handle invalid namespace", async () => {
      const result = await lookupOtelSemantics(
        "totally_invalid_namespace_that_does_not_exist",
      );

      expect(result).toContain(
        "Namespace 'totally_invalid_namespace_that_does_not_exist' not found",
      );
    });

    it("should suggest similar namespaces", async () => {
      const result = await lookupOtelSemantics("gen");

      expect(result).toContain("Did you mean:");
      expect(result).toContain("gen_ai");
    });
  });
});
