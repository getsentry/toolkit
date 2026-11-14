import "./instrument";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./index.css";
import App from "./app";
import { AuthProvider } from "./contexts/auth-context";
import * as Sentry from "@sentry/react";

const container = document.getElementById("root");

/**
 * Sentry types its handler with React's `ErrorInfo`, where `componentStack`
 * is `string | null`, while createRoot passes `string | undefined`. Map a
 * missing stack to null so both sides agree; Sentry only reads
 * `componentStack` and treats both values as "no stack".
 */
function rootErrorHandler(
  ...args: Parameters<typeof Sentry.reactErrorHandler>
) {
  const handler = Sentry.reactErrorHandler(...args);
  return (error: unknown, errorInfo: { componentStack?: string | undefined }) =>
    handler(error, {
      ...errorInfo,
      componentStack: errorInfo.componentStack ?? null,
    });
}

const root = createRoot(container!, {
  // Callback called when an error is thrown and not caught by an ErrorBoundary.
  onUncaughtError: rootErrorHandler((error, errorInfo) => {
    console.warn("Uncaught error", error, errorInfo.componentStack);
  }),
  // Callback called when React catches an error in an ErrorBoundary.
  onCaughtError: rootErrorHandler(),
  // Callback called when React automatically recovers from errors.
  onRecoverableError: rootErrorHandler(),
});

root.render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
