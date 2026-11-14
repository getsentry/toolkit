/**
 * Shared utilities for detecting and handling authentication errors
 */

export interface AuthErrorInfo {
  isAuthError: boolean;
  isExpired: boolean;
  isForbidden: boolean;
  statusCode?: 401 | 403;
}

/**
 * Analyze an error to determine if it's authentication-related
 */
export function analyzeAuthError(error: unknown): AuthErrorInfo {
  const result: AuthErrorInfo = {
    isAuthError: false,
    isExpired: false,
    isForbidden: false,
  };

  if (!(error instanceof Error)) {
    return result;
  }

  const errorMessage = error.message.toLowerCase();

  // Check for 401 Unauthorized errors
  if (
    errorMessage.includes("401") ||
    errorMessage.includes("unauthorized") ||
    errorMessage.includes("authentication") ||
    errorMessage.includes("invalid token") ||
    errorMessage.includes("access token")
  ) {
    result.isAuthError = true;
    result.isExpired = true;
    result.statusCode = 401;
  }

  // Check for 403 Forbidden errors
  if (errorMessage.includes("403") || errorMessage.includes("forbidden")) {
    result.isAuthError = true;
    result.isForbidden = true;
    result.statusCode = 403;
  }

  return result;
}

/**
 * Get appropriate error response based on auth error type
 */
export function getAuthErrorResponse(authInfo: AuthErrorInfo) {
  if (authInfo.isExpired) {
    return {
      error: "Authentication with Sentry has expired. Please log in again.",
      name: "AUTH_EXPIRED" as const,
    };
  }

  if (authInfo.isForbidden) {
    return {
      error: "You don't have permission to access this Sentry organization.",
      name: "INSUFFICIENT_PERMISSIONS" as const,
    };
  }

  return {
    error: "Authentication error occurred",
    name: "SENTRY_AUTH_INVALID" as const,
  };
}
