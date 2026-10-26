export type ConnectionState =
  | "connecting"
  | "connected"
  | "closed"
  | "reconnecting"
  | "missing"
  | "failed";

export type ConnectionPresentation = {
  label: string;
  tone: "neutral" | "success" | "warning";
};

export function getConnectionPresentation(
  connection: ConnectionState,
): ConnectionPresentation {
  switch (connection) {
    case "connected":
      return { label: "Connected to local receiver", tone: "success" };
    case "closed":
      return { label: "Capture stopped", tone: "neutral" };
    case "connecting":
      return { label: "Connecting to local receiver", tone: "neutral" };
    case "reconnecting":
      return { label: "Reconnecting to local receiver", tone: "warning" };
    case "missing":
      return { label: "Waiting for a local stream", tone: "neutral" };
    case "failed":
      return { label: "Receiver unavailable", tone: "warning" };
  }
}
import type { WorkspaceView } from "./workspace.ts";

export function getWorkspaceEmptyState({
  view,
  label,
  singularLabel,
  filtered,
  state,
}: {
  view: WorkspaceView;
  label: string;
  singularLabel: string;
  filtered: boolean;
  state: "capturing" | "saved" | "offline" | "cleared";
}): { title: string; description: string } {
  const items = label.toLowerCase();
  if (filtered) {
    return {
      title: `No matching ${items}`,
      description: `Adjust the filter or clear it to see all ${items} in this capture.`,
    };
  }
  if (state === "saved") {
    return {
      title: `No ${items} saved`,
      description: `This capture has stopped and its saved history contains no ${items}.`,
    };
  }
  if (state === "offline") {
    return {
      title: `No ${items} displayed`,
      description:
        "Reconnect to the receiver to load available capture history. History already displayed remains in this tab.",
    };
  }
  if (state === "cleared") {
    return {
      title: `No ${items} displayed`,
      description:
        "Clear view only affects this tab. Reload the capture to restore saved history; the receiver may have trimmed older events.",
    };
  }
  const triggers: Record<WorkspaceView, string> = {
    queries: "Run an instrumented database query in your app.",
    resources: "Load instrumented browser resources in your app.",
    "web-vitals":
      "Load a browser page with SDK performance measurements enabled.",
    attachments: "Send an SDK event with a file attachment.",
    live: `Send an SDK ${singularLabel} from your app to this receiver.`,
    traces:
      "Trigger an instrumented request or operation in your app to send a trace to this receiver.",
    errors:
      "Trigger a test error or failed request in your app and send it to this receiver.",
    logs: "Send a structured log through your app's Sentry SDK to this receiver.",
    ai: "Run an instrumented AI operation in your app to send its spans to this receiver.",
    envelopes:
      "Send an event through your app's Sentry SDK to inspect its raw envelope here.",
    sdks: "Run your app with SDK session tracking or client reporting enabled to send session and client reports.",
    feedback: "Submit user feedback through a supported SDK to this receiver.",
    profiles:
      "Enable SDK profiling and run an operation in your app to send profiling data to this receiver.",
  };
  return { title: `No ${items} captured`, description: triggers[view] };
}
