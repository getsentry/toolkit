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
  expect(history).toEqual(
    [9009, 9008, 9007, 9006, 9005].map(
      (port) => `http://localhost:${port}/stream`,
    ),
  );
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

test("reconnecting promotes a receiver and adding a sixth discards the least recent", () => {
  const url = (port: number) => `http://localhost:${port}/stream`;
  let history = [9005, 9004, 9003, 9002, 9001].map(url);
  history = rememberConnection(history, url(9001));
  expect(history).toEqual([9001, 9005, 9004, 9003, 9002].map(url));
  history = rememberConnection(history, url(9006));
  expect(history).toEqual([9006, 9001, 9005, 9004, 9003].map(url));
});

test("older eight-entry history loads and saves only the newest five", () => {
  const oldHistory = Array.from(
    { length: 8 },
    (_, index) => `http://localhost:${9008 - index}/stream`,
  );
  window.sessionStorage.setItem(
    CONNECTION_HISTORY_KEY,
    JSON.stringify(oldHistory),
  );
  expect(readConnectionHistory()).toEqual(oldHistory.slice(0, 5));
  saveConnectionHistory(oldHistory);
  expect(
    JSON.parse(window.sessionStorage.getItem(CONNECTION_HISTORY_KEY)!),
  ).toEqual(oldHistory.slice(0, 5));
});

test.each([
  {
    search: "?url=" + encodeURIComponent("https://remote.example/stream"),
    hash: "",
  },
  {
    search:
      "?url=" +
      encodeURIComponent(
        "http://localhost:8969/_local/v1/sessions/web/stream?cap=read",
      ),
    hash: "",
  },
  {
    search: "",
    hash: "#stream=" + encodeURIComponent("https://remote.example/stream"),
  },
])(
  "ignored connection links preserve a disconnected tab: $search $hash",
  ({ search, hash }) => {
    saveDisconnected(true);
    window.history.replaceState(null, "", "/" + search + hash);
    expect(getInitialDisconnected()).toBe(true);
  },
);

test("startup applies a valid query when an invalid fragment is ignored", () => {
  saveDisconnected(true);
  window.history.replaceState(
    null,
    "",
    "/?url=" +
      encodeURIComponent("http://127.0.0.1:8969/stream") +
      "#stream=invalid",
  );
  expect(getInitialDisconnected()).toBe(false);
});

test("an applied scoped CLI fragment can reconnect a disconnected tab", () => {
  saveDisconnected(true);
  window.history.replaceState(
    null,
    "",
    "/#stream=" +
      encodeURIComponent(
        "http://127.0.0.1:8969/_local/v1/sessions/web/stream?cap=read",
      ),
  );
  expect(getInitialDisconnected()).toBe(false);
});
