import { isLoopbackHost, parseStreamEndpoint } from "./spotlight.ts";

const DIRECTORY_STORAGE_KEY = "sentry.local.session-directory";
export type ViewerSession = {
  id: string;
  label: string;
  cwd: string;
  state: "open" | "retained";
  streamUrl: string;
  expiresAt?: number;
};

/** Discovery is opt-in and stays on the already selected loopback daemon. */
export function parseSessionDirectoryUrl(
  value: string | null | undefined,
  streamUrl: string,
): string | undefined {
  if (!value) return;
  try {
    const directory = new URL(value);
    const stream = parseStreamEndpoint(streamUrl);
    if (
      stream?.kind !== "loopback" ||
      !isLoopbackHost(directory.hostname) ||
      directory.origin !== new URL(stream.url).origin ||
      directory.username ||
      directory.password ||
      directory.hash ||
      directory.pathname !== "/_local/v1/ui/sessions" ||
      !directory.searchParams.get("cap")
    )
      return;
    return directory.toString();
  } catch {
    return;
  }
}

export function getInitialSessionDirectory(
  streamUrl: string,
): string | undefined {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  let saved: string | null = null;
  try {
    saved = window.sessionStorage.getItem(DIRECTORY_STORAGE_KEY);
  } catch {
    /* Storage may be disabled. */
  }
  const directory = parseSessionDirectoryUrl(
    fragment.has("directory") ? fragment.get("directory") : saved,
    streamUrl,
  );
  // The startup effect removes the fragment before discovery can finish. Save
  // its validated capability now so an early reload cannot lose the picker.
  if (directory && fragment.has("directory")) saveSessionDirectory(directory);
  return directory;
}

export function saveSessionDirectory(directoryUrl: string): void {
  try {
    window.sessionStorage.setItem(DIRECTORY_STORAGE_KEY, directoryUrl);
  } catch {
    /* Current tab still works without storage. */
  }
}

/** Treat daemon responses as untrusted; never follow off-daemon stream URLs. */
export function parseViewerSessions(
  value: unknown,
  directoryUrl: string,
): ViewerSession[] {
  if (
    !value ||
    typeof value !== "object" ||
    !("sessions" in value) ||
    !Array.isArray(value.sessions)
  )
    throw new Error("Invalid session directory");
  const origin = new URL(directoryUrl).origin;
  return value.sessions
    .map((entry: unknown): ViewerSession => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        throw new Error("Invalid session");
      const session = entry as Record<string, unknown>;
      const expiresAt = session.expiresAt;
      if (
        expiresAt !== undefined &&
        (typeof expiresAt !== "number" ||
          !Number.isSafeInteger(expiresAt) ||
          expiresAt <= 0)
      )
        throw new Error("Invalid session");
      if (
        typeof session.id !== "string" ||
        !session.id ||
        typeof session.label !== "string" ||
        typeof session.cwd !== "string" ||
        (session.state !== "open" && session.state !== "retained") ||
        typeof session.streamUrl !== "string"
      )
        throw new Error("Invalid session");
      const stream = parseStreamEndpoint(session.streamUrl);
      if (stream?.kind !== "loopback")
        throw new Error("Invalid session stream");
      const url = new URL(stream.url);
      if (
        url.origin !== origin ||
        url.pathname !==
          `/_local/v1/sessions/${encodeURIComponent(session.id)}/stream`
      )
        throw new Error("Invalid session stream");
      return {
        id: session.id,
        label: session.label,
        cwd: session.cwd,
        state: session.state,
        streamUrl: stream.url,
        ...(typeof expiresAt === "number" && { expiresAt }),
      };
    })
    .sort(
      (a, b) =>
        Number(a.state !== "open") - Number(b.state !== "open") ||
        a.label.localeCompare(b.label) ||
        a.id.localeCompare(b.id),
    );
}
