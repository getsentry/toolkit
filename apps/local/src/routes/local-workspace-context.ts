import { createContext, useContext } from "react";
import { type useWorkspaceQueryState } from "@/lib/workspace-query.ts";
import type { WorkspaceView } from "@/lib/workspace.ts";

export type LocalWorkspaceRouteState = {
  workspaceQuery: ReturnType<typeof useWorkspaceQueryState>;
  workspaceView: WorkspaceView;
  navigateToWorkspace: (view: WorkspaceView) => void;
  navigateToCommandEvent: (view: WorkspaceView, eventId: string) => void;
  navigateToCommandTrace: (view: WorkspaceView, traceId: string) => void;
};

export const LocalWorkspaceRouteContext =
  createContext<LocalWorkspaceRouteState | null>(null);

export function useLocalWorkspaceRoute() {
  const context = useContext(LocalWorkspaceRouteContext);
  if (!context) {
    throw new Error(
      "useLocalWorkspaceRoute must be used within LocalWorkspaceRoute",
    );
  }
  return context;
}
