import { beforeEach, expect, test } from "vitest";
import {
  parseSessionDirectoryUrl,
  parseViewerSessions,
  getInitialSessionDirectory,
} from "./session-directory.ts";
const stream =
  "http://127.0.0.1:8969/_local/v1/sessions/web/stream?cap=web-secret";
const directory =
  "http://127.0.0.1:8969/_local/v1/ui/sessions?cap=directory-secret";
beforeEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});
test("discovery never sends its capability to a different receiver or remote host", () => {
  expect(parseSessionDirectoryUrl(directory, stream)).toBe(directory);
  for (const target of [
    "https://evil.example/_local/v1/ui/sessions?cap=secret",
    "http://127.0.0.1:9999/_local/v1/ui/sessions?cap=secret",
    "http://127.0.0.1:8969/_local/v1/sessions?cap=secret",
    "http://127.0.0.1:8969/_local/v1/ui/sessions",
  ]) {
    expect(parseSessionDirectoryUrl(target, stream)).toBeUndefined();
  }
});
test("returned stream targets must belong to the listed session on the connected daemon", () => {
  const web = {
    id: "web",
    label: "same name",
    cwd: "/web",
    state: "open",
    streamUrl: stream,
  };
  expect(parseViewerSessions({ sessions: [web] }, directory)).toEqual([web]);
  for (const streamUrl of [
    stream.replace(":8969", ":9999"),
    stream.replace("/web/", "/worker/"),
    "https://evil.example/stream",
  ]) {
    expect(() =>
      parseViewerSessions({ sessions: [{ ...web, streamUrl }] }, directory),
    ).toThrow();
  }
  expect(() =>
    parseViewerSessions(
      { sessions: [{ ...web, state: "invalid" }] },
      directory,
    ),
  ).toThrow();
});
test("explicit discovery is tab-scoped and cannot follow a saved directory to another daemon", () => {
  window.history.replaceState(
    null,
    "",
    `/#${new URLSearchParams({ stream, directory })}`,
  );
  expect(getInitialSessionDirectory(stream)).toBe(directory);
  window.history.replaceState(null, "", "/");
  expect(getInitialSessionDirectory(stream)).toBe(directory);
  expect(
    getInitialSessionDirectory(stream.replace(":8969", ":9999")),
  ).toBeUndefined();
});

test("invalid fragment discovery is never persisted", () => {
  window.history.replaceState(
    null,
    "",
    `/#${new URLSearchParams({ directory: directory.replace(":8969", ":9999") })}`,
  );
  expect(getInitialSessionDirectory(stream)).toBeUndefined();
  window.history.replaceState(null, "", "/");
  expect(getInitialSessionDirectory(stream)).toBeUndefined();
});

test("optional saved-capture deadlines preserve older directories and reject invalid timestamps", () => {
  const saved = {
    id: "web",
    label: "web",
    cwd: "/web",
    state: "retained",
    streamUrl: stream,
  };
  expect(parseViewerSessions({ sessions: [saved] }, directory)).toEqual([
    saved,
  ]);
  const expiresAt = 1_795_000_000_000;
  expect(
    parseViewerSessions({ sessions: [{ ...saved, expiresAt }] }, directory),
  ).toEqual([{ ...saved, expiresAt }]);
  for (const expiresAt of [
    0,
    -1,
    1.5,
    Number.NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    "1795000000000",
    null,
  ]) {
    expect(() =>
      parseViewerSessions({ sessions: [{ ...saved, expiresAt }] }, directory),
    ).toThrow("Invalid session");
  }
});
