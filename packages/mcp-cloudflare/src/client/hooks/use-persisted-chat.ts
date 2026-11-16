import { useCallback, useMemo } from "react";
import type { UIMessage } from "ai";

const CHAT_STORAGE_KEY = "sentry_chat_messages";
const TIMESTAMP_STORAGE_KEY = "sentry_chat_timestamp";
const MAX_STORED_MESSAGES = 100; // Limit storage size
const CACHE_EXPIRY_MS = 60 * 60 * 1000; // 1 hour in milliseconds

// Legacy AI SDK 4.x message format (before migration to parts-based format)
interface LegacyMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content?: string;
  parts?: UIMessage["parts"];
  // Legacy used 'data', new SDK uses 'metadata'
  data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

// Migrate legacy messages (AI SDK 4.x format with `content`) to new format (with `parts`)
function migrateMessage(msg: LegacyMessage): UIMessage {
  // Preserve metadata from either 'metadata' or legacy 'data' property
  const metadata = msg.metadata ?? msg.data;

  // If message already has parts, use it as-is (but ensure metadata is preserved)
  if (msg.parts && Array.isArray(msg.parts) && msg.parts.length > 0) {
    if (metadata) {
      return { ...msg, metadata } as UIMessage;
    }
    return msg as UIMessage;
  }

  // If message has legacy content string, convert to parts format
  if (typeof msg.content === "string" && msg.content.length > 0) {
    return {
      id: msg.id,
      role: msg.role,
      parts: [{ type: "text", text: msg.content }],
      ...(metadata && { metadata }),
    };
  }

  // Return as-is if neither format matches (will be filtered by validation)
  return msg as UIMessage;
}

export function usePersistedChat(isAuthenticated: boolean) {
  // Check if cache is expired
  const isCacheExpired = useCallback(() => {
    try {
      const timestampStr = localStorage.getItem(TIMESTAMP_STORAGE_KEY);
      if (!timestampStr) return true;

      const timestamp = Number.parseInt(timestampStr, 10);
      const now = Date.now();
      return now - timestamp > CACHE_EXPIRY_MS;
    } catch {
      return true;
    }
  }, []);

  // Update timestamp to extend cache expiry
  const updateTimestamp = useCallback(() => {
    try {
      localStorage.setItem(TIMESTAMP_STORAGE_KEY, Date.now().toString());
    } catch (error) {
      console.error("Failed to update chat timestamp:", error);
    }
  }, []);

  // Validate a message to ensure it won't cause conversion errors
  const isValidMessage = useCallback((msg: UIMessage): boolean => {
    // Persisted messages come from localStorage, and migrateMessage passes
    // unrecognized shapes through, so parts may be missing despite the type.
    const parts: unknown = msg.parts;
    if (!Array.isArray(parts) || parts.length === 0) {
      return false;
    }

    // Invalid states that indicate incomplete tool calls
    const incompleteToolStates = new Set([
      "input-streaming",
      "input-available",
      "approval-requested",
    ]);

    return msg.parts.every((part) => {
      // Text parts are always valid
      if (part.type === "text") {
        return true;
      }

      // AI SDK 6.x uses "tool-<toolname>" format (e.g., "tool-whoami")
      // Filter out incomplete tool calls that shouldn't be persisted
      if (part.type.startsWith("tool-")) {
        const { state } = part as { state?: string };
        return !incompleteToolStates.has(state ?? "");
      }

      // Legacy "tool-invocation" format (AI SDK 4.x)
      // Structure: { type: "tool-invocation", toolInvocation: { state, result, ... } }
      if (part.type === "tool-invocation") {
        const invocation = (
          part as {
            toolInvocation?: {
              state?: string;
              result?: { content?: unknown };
            };
          }
        ).toolInvocation;
        if (!invocation) return true; // No invocation data, allow it
        // "call" or "result" state requires valid content
        if (invocation.state === "call" || invocation.state === "result") {
          const content = invocation.result?.content;
          return (
            content != null && (!Array.isArray(content) || content.length > 0)
          );
        }
        // partial-call state is okay without result
        return true;
      }

      // Other part types (reasoning, file, source-url, etc.) are valid
      return true;
    });
  }, []);

  // Load initial messages from localStorage
  const initialMessages = useMemo(() => {
    if (!isAuthenticated) return [];

    // Check if cache is expired
    if (isCacheExpired()) {
      // Clear expired data
      localStorage.removeItem(CHAT_STORAGE_KEY);
      localStorage.removeItem(TIMESTAMP_STORAGE_KEY);
      return [];
    }

    try {
      const stored = localStorage.getItem(CHAT_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as LegacyMessage[];
        // Validate the data structure
        if (Array.isArray(parsed) && parsed.length > 0) {
          // Migrate legacy messages and filter out any invalid ones
          const migratedMessages = parsed.map(migrateMessage);
          const validMessages = migratedMessages.filter(isValidMessage);
          if (validMessages.length > 0) {
            // Update timestamp since we're loading existing messages
            updateTimestamp();
            return validMessages;
          }
        }
      }
    } catch (error) {
      console.error("Failed to load chat history:", error);
      // Clear corrupted data
      localStorage.removeItem(CHAT_STORAGE_KEY);
      localStorage.removeItem(TIMESTAMP_STORAGE_KEY);
    }

    return [];
  }, [isAuthenticated, isCacheExpired, updateTimestamp, isValidMessage]);

  // Function to save messages
  const saveMessages = useCallback(
    (messages: UIMessage[]) => {
      if (!isAuthenticated || messages.length === 0) return;

      try {
        // Filter out invalid messages before storing
        const validMessages = messages.filter(isValidMessage);

        // Only store the most recent valid messages to avoid storage limits
        const messagesToStore = validMessages.slice(-MAX_STORED_MESSAGES);

        // Don't save if there are no valid messages
        if (messagesToStore.length === 0) {
          localStorage.removeItem(CHAT_STORAGE_KEY);
          localStorage.removeItem(TIMESTAMP_STORAGE_KEY);
          return;
        }

        localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messagesToStore));
        // Update timestamp when saving messages (extends expiry)
        updateTimestamp();
      } catch (error) {
        console.error("Failed to save chat history:", error);
        // If we hit storage quota, try to clear old messages
        if (
          error instanceof DOMException &&
          error.name === "QuotaExceededError"
        ) {
          try {
            const validMessages = messages.filter(isValidMessage);
            const recentMessages = validMessages.slice(-50); // Keep only last 50
            localStorage.setItem(
              CHAT_STORAGE_KEY,
              JSON.stringify(recentMessages),
            );
            updateTimestamp();
          } catch {
            // If still failing, clear the storage
            localStorage.removeItem(CHAT_STORAGE_KEY);
            localStorage.removeItem(TIMESTAMP_STORAGE_KEY);
          }
        }
      }
    },
    [isAuthenticated, updateTimestamp, isValidMessage],
  );

  // Clear persisted messages
  const clearPersistedMessages = useCallback(() => {
    localStorage.removeItem(CHAT_STORAGE_KEY);
    localStorage.removeItem(TIMESTAMP_STORAGE_KEY);
  }, []);

  return {
    initialMessages,
    saveMessages,
    clearPersistedMessages,
  };
}
