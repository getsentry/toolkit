import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { useWorkspaceQueryState } from "@/lib/workspace-query.ts";
import {
  workspaceFromPath,
  workspacePath,
  type WorkspaceView,
} from "@/lib/workspace.ts";
import { LocalWorkspaceRouteContext } from "./local-workspace-context.ts";

export function LocalWorkspaceRoute({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const workspaceQuery = useWorkspaceQueryState();

  const navigateToWorkspace = (view: WorkspaceView) => {
    // navigate() can return a promise; `void` marks this as deliberate
    // fire-and-forget for no-floating-promises.
    void navigate({ pathname: workspacePath(view), search: location.search });
  };

  const navigateToCommandSelection = (
    view: WorkspaceView,
    selection: { event?: string; trace?: string },
  ) => {
    const search = new URLSearchParams(location.search);
    search.delete("event");
    search.delete("q");
    search.delete("trace");
    if (selection.event) {
      search.set("event", selection.event);
    }
    if (selection.trace) {
      search.set("trace", selection.trace);
    }
    const query = search.toString();
    // Fire-and-forget, as in navigateToWorkspace.
    void navigate({
      pathname: workspacePath(view),
      search: query ? `?${query}` : "",
    });
  };

  return (
    <LocalWorkspaceRouteContext.Provider
      value={{
        workspaceQuery,
        workspaceView: workspaceFromPath(location.pathname),
        navigateToWorkspace,
        navigateToCommandEvent: (view, eventId) =>
          navigateToCommandSelection(view, { event: eventId }),
        navigateToCommandTrace: (view, traceId) =>
          navigateToCommandSelection(view, { trace: traceId }),
      }}
    >
      {children}
    </LocalWorkspaceRouteContext.Provider>
  );
}
