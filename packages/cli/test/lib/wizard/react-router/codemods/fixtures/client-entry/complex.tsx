import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";
import { SomeProvider } from "./providers";
import { GlobalStyles } from "./styles";

// Some configuration
const config = {
  enableTracing: true,
  debugMode: false,
};

// Initialize the app
function initializeApp() {
  console.log('Initializing app with config:', config);
}

startTransition(() => {
  initializeApp();

  hydrateRoot(
    document,
    <StrictMode>
      <SomeProvider>
        <GlobalStyles />
        <HydratedRouter />
      </SomeProvider>
    </StrictMode>
  );
});
