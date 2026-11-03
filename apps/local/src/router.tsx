import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { NuqsAdapter } from "nuqs/adapters/react";
import App from "./App.tsx";
import { LocalWorkspaceRoute } from "./routes/local-workspace-route.tsx";

function WorkspaceRoute() {
  return (
    <LocalWorkspaceRoute>
      <App />
    </LocalWorkspaceRoute>
  );
}

const localRouter = createBrowserRouter([
  { path: "/", Component: WorkspaceRoute },
  { path: "/live", Component: WorkspaceRoute },
  { path: "/traces", Component: WorkspaceRoute },
  { path: "/errors", Component: WorkspaceRoute },
  { path: "/logs", Component: WorkspaceRoute },
  { path: "/ai", Component: WorkspaceRoute },
  { path: "/envelopes", Component: WorkspaceRoute },
  { path: "/sdks", Component: WorkspaceRoute },
  { path: "/feedback", Component: WorkspaceRoute },
  { path: "/profiles", Component: WorkspaceRoute },
  { path: "/queries", Component: WorkspaceRoute },
  { path: "/resources", Component: WorkspaceRoute },
  { path: "/web-vitals", Component: WorkspaceRoute },
  { path: "/attachments", Component: WorkspaceRoute },
  { path: "*", element: <Navigate to="/live" replace /> },
]);

export function LocalRouter() {
  return (
    <NuqsAdapter>
      <RouterProvider router={localRouter} />
    </NuqsAdapter>
  );
}
