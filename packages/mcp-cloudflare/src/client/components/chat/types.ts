/**
 * Type definitions for Chat components
 */

import type React from "react";
import type { UIMessage } from "@ai-sdk/react";

// Re-export AI SDK types for convenience - Message renamed to UIMessage in AI SDK 5+
export type { UIMessage as Message } from "@ai-sdk/react";

// The custom metadata the chat attaches to messages. Messages are persisted
// in localStorage, so read it with `readChatMessageData`.
export interface ChatMessageData {
  type?: string;
  toolsDetailed?: Array<{ name: string; description: string }>;
  hasSlashCommands?: boolean;
  // Prompt execution data
  promptName?: string;
  parameters?: Record<string, unknown>;
  wasExecuted?: boolean;
  simulateStreaming?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolSummary(
  value: unknown,
): value is { name: string; description: string } {
  return (
    isRecord(value) &&
    typeof value["name"] === "string" &&
    typeof value["description"] === "string"
  );
}

/** Reads the fields of `ChatMessageData` that `metadata` holds. */
export function readChatMessageData(
  metadata: unknown,
): ChatMessageData | undefined {
  if (!isRecord(metadata)) {
    return undefined;
  }
  const {
    type,
    toolsDetailed,
    hasSlashCommands,
    promptName,
    parameters,
    wasExecuted,
    simulateStreaming,
  } = metadata;
  return {
    ...(typeof type === "string" && { type }),
    ...(Array.isArray(toolsDetailed) && {
      toolsDetailed: toolsDetailed.filter(isToolSummary),
    }),
    ...(typeof hasSlashCommands === "boolean" && { hasSlashCommands }),
    ...(typeof promptName === "string" && { promptName }),
    ...(isRecord(parameters) && { parameters }),
    ...(typeof wasExecuted === "boolean" && { wasExecuted }),
    ...(typeof simulateStreaming === "boolean" && { simulateStreaming }),
  };
}

// Error handling types (simplified)
// We only keep this for potential server response parsing
export interface ChatErrorData {
  error?: string;
  name?: string;
  eventId?: string;
  statusCode?: number;
  message?: string;
}

// Authentication types
export interface AuthState {
  isLoading: boolean;
  isAuthenticated: boolean;
  authToken: string;
  isAuthenticating: boolean;
  authError: string;
}

export interface AuthActions {
  handleOAuthLogin: () => void;
  handleLogout: () => void;
  clearAuthState: () => void;
}

export type AuthContextType = AuthState & AuthActions;

// OAuth message types
export interface OAuthSuccessMessage {
  type: "SENTRY_AUTH_SUCCESS";
  data: Record<string, never>;
}

export interface OAuthErrorMessage {
  type: "SENTRY_AUTH_ERROR";
  error?: string;
}

export type OAuthMessage = OAuthSuccessMessage | OAuthErrorMessage;

// Tool invocation types
export interface ToolInvocationContent {
  type: "text";
  text: string;
}

export interface ToolInvocationUnknownContent {
  type: string;
  [key: string]: unknown;
}

export type ToolMessage = ToolInvocationContent | ToolInvocationUnknownContent;

// Define our own ToolInvocation interface since AI SDK's is not properly exported
export interface ChatToolInvocation {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  state: "partial-call" | "call" | "result";
  result?: {
    content: ToolMessage[];
  };
}

// Message processing types
export interface ProcessedMessagePart {
  part: NonNullable<UIMessage["parts"]>[number];
  messageId: string;
  messageRole: string;
  partIndex: number;
  isStreaming: boolean;
}

// Component prop types
export interface ChatProps {
  isOpen: boolean;
  isMobile?: boolean;
  onClose: () => void;
  onLogout: () => void;
}

export interface ChatUIProps {
  messages: UIMessage[];
  input: string;
  error?: Error | null;
  isChatLoading: boolean;
  isOpen?: boolean;
  showControls?: boolean;
  onInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  onStop?: () => void;
  onRetry?: () => void;
  onClose?: () => void;
  onLogout?: () => void;
  onSlashCommand?: (command: string) => void;
  onSendPrompt?: (prompt: string) => void;
}

// Optional props below are forwarded from parent props, so they accept an
// explicit `undefined` and treat it as absent.
export interface ChatMessagesProps {
  messages: UIMessage[];
  isChatLoading: boolean;
  isMessageStreaming?: ((messageId: string) => boolean) | undefined;
  error?: Error | undefined;
  onRetry?: (() => void) | undefined;
  onSlashCommand?: ((command: string) => void) | undefined;
}

export interface ChatInputProps {
  input: string;
  isLoading: boolean;
  isOpen: boolean;
  onInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  onStop: () => void;
}

export interface AuthFormProps {
  authError: string;
  onOAuthLogin: () => void;
}

export interface PanelBackdropProps {
  isOpen: boolean;
  onClose: () => void;
}

export interface MessagePartProps {
  part: NonNullable<UIMessage["parts"]>[number];
  messageId: string;
  messageRole: string;
  partIndex: number;
  isStreaming?: boolean | undefined;
  messageData?: ChatMessageData | undefined;
  onSlashCommand?: ((command: string) => void) | undefined;
}

export interface TextPartProps {
  text: string;
  role: string;
  messageId: string;
  isStreaming?: boolean | undefined;
  messageData?: ChatMessageData | undefined;
  onSlashCommand?: ((command: string) => void) | undefined;
}

export interface ToolPartProps {
  toolInvocation: ChatToolInvocation;
  messageId: string;
  partIndex: number;
}

export interface ToolInvocationProps {
  tool: ChatToolInvocation;
  messageId: string;
  index: number;
}

// Type guards
export function isTextMessage(
  message: ToolMessage,
): message is ToolInvocationContent {
  return message.type === "text";
}

export function isOAuthSuccessMessage(
  message: unknown,
): message is OAuthSuccessMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "SENTRY_AUTH_SUCCESS"
  );
}

export function isOAuthErrorMessage(
  message: unknown,
): message is OAuthErrorMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "SENTRY_AUTH_ERROR"
  );
}
