import {
  Activity,
  Bot,
  Boxes,
  Bug,
  FileArchive,
  Gauge,
  ListTree,
  MessageSquareText,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import type { LocalFeedItem } from "./spotlight.ts";
import type { LocalTelemetrySnapshot } from "./telemetry-store.ts";
import type { WorkspaceView } from "./workspace.ts";

export type WorkspaceNavigationItem = {
  id: WorkspaceView;
  label: string;
  singularLabel: string;
  section: "Explore" | "Diagnostics";
  emptyState: {
    title: string;
    description: string;
  };
  icon: LucideIcon;
  getItems: (snapshot: LocalTelemetrySnapshot) => LocalFeedItem[];
};

export const workspaceNavigation: WorkspaceNavigationItem[] = [
  {
    id: "live",
    label: "Events",
    singularLabel: "event",
    section: "Explore",
    emptyState: {
      title: "Waiting for events",
      description: "Incoming local telemetry will appear here.",
    },
    icon: Activity,
    getItems: (snapshot) => snapshot.items,
  },
  {
    id: "traces",
    label: "Traces",
    singularLabel: "trace",
    section: "Explore",
    emptyState: {
      title: "No traces captured",
      description:
        "Transactions and spans from your receiver will appear here as a single trace.",
    },
    icon: ListTree,
    getItems: (snapshot) => snapshot.traces,
  },
  {
    id: "errors",
    label: "Errors",
    singularLabel: "error",
    section: "Explore",
    emptyState: {
      title: "No errors captured",
      description:
        "Errors and failed requests from this receiver will appear here.",
    },
    icon: Bug,
    getItems: (snapshot) => snapshot.errors,
  },
  {
    id: "logs",
    label: "Logs",
    singularLabel: "log",
    section: "Explore",
    emptyState: {
      title: "No logs captured",
      description:
        "Structured logs sent through the receiver will appear here.",
    },
    icon: Terminal,
    getItems: (snapshot) => snapshot.logs,
  },
  {
    id: "ai",
    label: "AI",
    singularLabel: "AI event",
    section: "Explore",
    emptyState: {
      title: "No AI activity captured",
      description: "AI spans and related telemetry will appear here.",
    },
    icon: Bot,
    getItems: (snapshot) => snapshot.ai,
  },
  {
    id: "envelopes",
    label: "Envelopes",
    singularLabel: "envelope",
    section: "Diagnostics",
    emptyState: {
      title: "No envelopes received",
      description: "Raw envelopes received by this viewer will appear here.",
    },
    icon: FileArchive,
    getItems: (snapshot) => snapshot.envelopes,
  },
  {
    id: "sdks",
    label: "SDK reports",
    singularLabel: "session or client report",
    section: "Diagnostics",
    emptyState: {
      title: "No sessions or client reports",
      description: "SDK sessions and client reports will appear here.",
    },
    icon: Boxes,
    getItems: (snapshot) => snapshot.sdks,
  },
  {
    id: "feedback",
    label: "Feedback",
    singularLabel: "feedback item",
    section: "Diagnostics",
    emptyState: {
      title: "No feedback received",
      description:
        "User feedback submitted through supported SDKs will appear here.",
    },
    icon: MessageSquareText,
    getItems: (snapshot) => snapshot.feedback,
  },
  {
    id: "profiles",
    label: "Profiles",
    singularLabel: "profile",
    section: "Diagnostics",
    emptyState: {
      title: "No profiles captured",
      description: "Profiling data from supported SDKs will appear here.",
    },
    icon: Gauge,
    getItems: (snapshot) => snapshot.profiles,
  },
];
