import { parseAsString, useQueryStates } from "nuqs";

const workspaceQueryParsers = {
  event: parseAsString,
  trace: parseAsString,
  q: parseAsString.withDefault(""),
};

export function useWorkspaceQueryState() {
  const [state, setState] = useQueryStates(workspaceQueryParsers);

  return {
    eventId: state.event,
    query: state.q,
    traceId: state.trace,
    clearWorkspace: () =>
      setState({ event: null, q: null, trace: null }, { history: "replace" }),
    resetWorkspace: () =>
      setState({ event: null, trace: null }, { history: "replace" }),
    selectEvent: (eventId: string) =>
      setState({ event: eventId, trace: null }, { history: "push" }),
    selectTrace: (traceId: string) =>
      setState({ event: null, trace: traceId }, { history: "push" }),
    setSearchQuery: (query: string) =>
      setState({ q: query || null }, { history: "replace" }),
  };
}
