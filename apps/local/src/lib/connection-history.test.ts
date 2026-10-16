import { afterEach, expect, test } from "vitest";
import {
  CONNECTION_HISTORY_KEY,
  getInitialDisconnected,
  saveDisconnected,
  connectionLabel,
  readConnectionHistory,
  rememberConnection,
  saveConnectionHistory,
} from "./connection-history.ts";

afterEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

test("recent receivers deduplicate daemon sessions without storing their capabilities", () => {
  let history: string[] = [];
  for (let port = 9000; port < 9010; port++)
    history = rememberConnection(history, `http://localhost:${port}/stream`);
  history = rememberConnection(
    history,
    "http://localhost:9009/_local/v1/sessions/web/stream?cap=private-session",
  );
  expect(history).toHaveLength(8);
  expect(history[0]).toBe("http://localhost:9009/stream");
  saveConnectionHistory(history);
  expect(window.sessionStorage.getItem(CONNECTION_HISTORY_KEY)).not.toContain(
    "private-session",
  );
  expect(readConnectionHistory()).toEqual(history);
});

test("remote history survives reload in this tab and hides query credentials in its label", () => {
  const url = "https://receiver.example/stream?token=private-remote";
  saveConnectionHistory(rememberConnection([], url));
  expect(readConnectionHistory()).toEqual([url]);
  expect(connectionLabel(url)).toBe("https://receiver.example/stream");
  expect(window.localStorage.getItem(CONNECTION_HISTORY_KEY)).toBeNull();
});

test("history rejects malformed storage and unsafe endpoints", () => {
  window.sessionStorage.setItem(CONNECTION_HISTORY_KEY, "invalid JSON");
  expect(readConnectionHistory()).toEqual([]);
  window.sessionStorage.setItem(
    CONNECTION_HISTORY_KEY,
    JSON.stringify([
      null,
      1,
      "http://remote.example/stream",
      "https://user:password@receiver.example/stream",
      "http://localhost:9000/stream",
    ]),
  );
  expect(readConnectionHistory()).toEqual(["http://localhost:9000/stream"]);
});

test("disconnect survives reload but an explicit receiver link overrides it", () => {
  saveDisconnected(true);
  expect(getInitialDisconnected()).toBe(true);
  window.history.replaceState(
    null,
    "",
    "/?url=" + encodeURIComponent("http://127.0.0.1:8969/stream"),
  );
  expect(getInitialDisconnected()).toBe(false);
  window.history.replaceState(null, "", "/");
  expect(getInitialDisconnected()).toBe(true);
  saveDisconnected(false);
  expect(getInitialDisconnected()).toBe(false);
});
