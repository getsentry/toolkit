/**
 * Simplified chat error handling utilities
 * Only handles two concerns: auth errors vs other errors
 */

/**
 * Check if an error is authentication-related (401)
 */
export function isAuthError(error: Error): boolean {
  const message = error.message.toLowerCase();

  // Check for 401 status code or auth-related keywords
  return (
    message.includes("401") ||
    message.includes("auth_expired") ||
    message.includes("invalid_token") ||
    message.includes("session has expired") ||
    message.includes("unauthorized")
  );
}

/**
 * Extract a user-friendly error message from the error
 */
export function getErrorMessage(error: Error): string {
  try {
    // Try to parse JSON error response
    const jsonMatch = error.message.match(/\{.*\}/);
    if (jsonMatch) {
      const data: unknown = JSON.parse(jsonMatch[0]);
      if (
        typeof data === "object" &&
        data !== null &&
        "error" in data &&
        typeof data.error === "string" &&
        data.error
      ) {
        return data.error;
      }
    }
  } catch {
    // Ignore JSON parse errors
  }

  // Check for specific error types
  if (isAuthError(error)) {
    return "Your session has expired. Please log in again.";
  }

  if (
    error.message.includes("429") ||
    error.message.toLowerCase().includes("rate_limit")
  ) {
    return "You've sent too many messages. Please wait a moment before trying again.";
  }

  if (
    error.message.includes("403") ||
    error.message.toLowerCase().includes("permission")
  ) {
    return "You don't have permission to access this organization.";
  }

  if (error.message.includes("500")) {
    return "Something went wrong on our end. Please try again.";
  }

  // Default message
  return "An error occurred. Please try again.";
}
