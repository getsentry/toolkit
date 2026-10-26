import { parseAsString, useQueryStates } from "nuqs";

const workspaceQueryParsers = {
  event: parseAsString,
  trace: parseAsString,
  span: parseAsString,
  q: parseAsString.withDefault(""),
};

export function useWorkspaceQueryState() {
  const [state, setState] = useQueryStates(workspaceQueryParsers);

  return {
    eventId: state.event,
    query: state.q,
    traceId: state.trace,
    spanId: state.span,
    clearWorkspace: () =>
      setState(
        { event: null, q: null, trace: null, span: null },
        { history: "replace" },
      ),
    resetWorkspace: () =>
      setState(
        { event: null, trace: null, span: null },
        { history: "replace" },
      ),
    selectEvent: (eventId: string) =>
      setState(
        { event: eventId, trace: null, span: null },
        { history: "push" },
      ),
    selectTrace: (traceId: string) =>
      setState(
        { event: null, trace: traceId, span: null },
        { history: "push" },
      ),
    selectSpan: (traceId: string, spanId: string) =>
      setState(
        { event: null, trace: traceId, span: spanId },
        { history: "push" },
      ),
    clearSpan: () => setState({ span: null }, { history: "replace" }),
    setSearchQuery: (query: string) =>
      setState({ q: query || null }, { history: "replace" }),
  };
}
