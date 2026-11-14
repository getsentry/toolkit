import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import type { AuthContextType } from "../components/chat/types";
import {
  isOAuthSuccessMessage,
  isOAuthErrorMessage,
} from "../components/chat/types";

const POPUP_CHECK_INTERVAL = 1000;

const AuthContext = createContext<AuthContextType | undefined>(undefined);

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [authError, setAuthError] = useState("");

  // Keep refs for cleanup
  const popupRef = useRef<Window | null>(null);
  const intervalRef = useRef<number | null>(null);

  // Check if authenticated by making a request to the server
  useEffect(() => {
    // Check authentication status
    fetch("/api/auth/status", { credentials: "include" })
      .then((res) => res.ok)
      .then((authenticated) => {
        setIsAuthenticated(authenticated);
        setIsLoading(false);
      })
      .catch(() => {
        setIsAuthenticated(false);
        setIsLoading(false);
      });
  }, []);

  // Process OAuth result from localStorage
  const processOAuthResult = useCallback((data: unknown) => {
    if (isOAuthSuccessMessage(data)) {
      // Verify session on server before marking authenticated
      fetch("/api/auth/status", { credentials: "include" })
        .then((res) => res.ok)
        .then((authenticated) => {
          if (authenticated) {
            // Fully reload the app to pick up new auth context/cookies
            // This avoids intermediate/loading states and ensures a clean session
            window.location.reload();
          } else {
            setIsAuthenticated(false);
            setAuthError(
              "Authentication not completed. Please finish sign-in.",
            );
            setIsAuthenticating(false);
          }
        })
        .catch(() => {
          setIsAuthenticated(false);
          setAuthError("Failed to verify authentication.");
          setIsAuthenticating(false);
        });

      // Cleanup interval and popup reference
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (popupRef.current) {
        popupRef.current = null;
      }
    } else if (isOAuthErrorMessage(data)) {
      setAuthError(data.error || "Authentication failed");
      setIsAuthenticating(false);

      // Cleanup interval and popup reference
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (popupRef.current) {
        popupRef.current = null;
      }
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);

  const handleOAuthLogin = useCallback(() => {
    setIsAuthenticating(true);
    setAuthError("");

    const desiredWidth = Math.max(Math.min(window.screen.availWidth, 900), 600);
    const desiredHeight = Math.min(window.screen.availHeight, 900);
    const windowFeatures = `width=${desiredWidth},height=${desiredHeight},resizable=yes,scrollbars=yes`;

    // Clear any stale results before opening popup
    try {
      localStorage.removeItem("oauth_result");
    } catch {
      // ignore storage errors
    }

    const popup = window.open(
      "/api/auth/authorize",
      "sentry-oauth",
      windowFeatures,
    );

    if (!popup) {
      setAuthError("Popup blocked. Please allow popups and try again.");
      setIsAuthenticating(false);
      return;
    }

    popupRef.current = popup;

    // Poll for OAuth result in localStorage
    // We don't check popup.closed as it's unreliable with cross-origin windows
    intervalRef.current = window.setInterval(() => {
      // Check localStorage for auth result
      const storedResult = localStorage.getItem("oauth_result");
      if (storedResult) {
        try {
          const result = JSON.parse(storedResult);
          localStorage.removeItem("oauth_result");
          processOAuthResult(result);

          // Clear interval since we got a result
          if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
          }
          popupRef.current = null;
        } catch (e) {
          // Invalid stored result, continue polling
        }
      }
    }, POPUP_CHECK_INTERVAL);

    // Stop polling after 5 minutes (safety timeout)
    setTimeout(() => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;

        // Final check if we're authenticated
        fetch("/api/auth/status", { credentials: "include" })
          .then((res) => res.ok)
          .then((authenticated) => {
            if (authenticated) {
              window.location.reload();
            } else {
              setIsAuthenticating(false);
              setAuthError("Authentication timed out. Please try again.");
            }
          })
          .catch(() => {
            setIsAuthenticating(false);
            setAuthError("Authentication timed out. Please try again.");
          });
      }
    }, 300000); // 5 minutes
  }, [processOAuthResult]);

  const handleLogout = useCallback(() => {
    void (async () => {
      try {
        await fetch("/api/auth/logout", {
          method: "POST",
          credentials: "include",
        });
      } catch {
        // Ignore errors, proceed with local logout
      }

      setIsAuthenticated(false);
    })();
  }, []);

  const clearAuthState = useCallback(() => {
    setIsAuthenticated(false);
    setAuthError("");
  }, []);

  const value: AuthContextType = {
    isLoading,
    isAuthenticated,
    authToken: "", // Keep for backward compatibility
    isAuthenticating,
    authError,
    handleOAuthLogin,
    handleLogout,
    clearAuthState,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
