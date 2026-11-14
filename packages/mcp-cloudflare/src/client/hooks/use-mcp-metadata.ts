/**
 * Custom hook to fetch and manage MCP metadata
 *
 * Provides immediate access to prompts and tools without waiting for chat stream
 */
import { useState, useEffect, useCallback } from "react";

/** The `/api/metadata` response the chat reads. */
export interface McpMetadata {
  tools: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Reads the tool list from a response, or null when it has none. */
function parseMcpMetadata(data: unknown): McpMetadata | null {
  if (!isRecord(data) || !Array.isArray(data["tools"])) {
    return null;
  }
  const tools: unknown[] = data["tools"];
  return {
    tools: tools.filter((tool): tool is string => typeof tool === "string"),
  };
}

interface UseMcpMetadataResult {
  metadata: McpMetadata | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

export function useMcpMetadata(enabled = true): UseMcpMetadataResult {
  const [metadata, setMetadata] = useState<McpMetadata | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchMetadata = useCallback(async () => {
    if (!enabled) {
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/metadata", {
        credentials: "include", // Include cookies
      });

      if (!response.ok) {
        const errorData: unknown = await response.json().catch(() => ({}));
        const message =
          isRecord(errorData) && typeof errorData["error"] === "string"
            ? errorData["error"]
            : "";
        throw new Error(message || `HTTP ${response.status}`);
      }

      const data: unknown = await response.json();
      setMetadata(parseMcpMetadata(data));
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to fetch metadata";
      setError(errorMessage);
      console.error("Failed to fetch MCP metadata:", err);
    } finally {
      setIsLoading(false);
    }
  }, [enabled]);

  // Fetch metadata when auth token changes or component mounts
  useEffect(() => {
    void fetchMetadata();
  }, [fetchMetadata]);

  return {
    metadata,
    isLoading,
    error,
    refetch: fetchMetadata,
  };
}
