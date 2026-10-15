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
      return { label: "Telemetry session closed", tone: "neutral" };
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
