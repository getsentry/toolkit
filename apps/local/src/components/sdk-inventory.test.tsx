import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { decodeEnvelope } from "@/lib/spotlight.ts";
import { SdkInventory } from "./sdk-inventory.tsx";

beforeEach(() => {
  // "Last seen" adds the date only for other days, so pin today.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-17T20:31:00.000Z"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test("Last seen uses local time for epoch and ISO timestamps", () => {
  const items = [
    ...decodeEnvelope(
      JSON.stringify([
        { sdk: { name: "sentry.python.flask", version: "2.47.0" } },
        [
          [
            { type: "event" },
            { timestamp: 1794947420.913, platform: "python" },
          ],
        ],
      ]),
      "python",
    ),
    ...decodeEnvelope(
      JSON.stringify([
        {
          sent_at: "2026-11-17T20:30:25.000Z",
          sdk: { name: "sentry.javascript.nextjs", version: "10.20.0" },
        },
        [[{ type: "session" }, { status: "ok" }]],
      ]),
      "nextjs",
    ),
  ];
  render(<SdkInventory items={items} />);
  const rows = screen.getAllByRole("row").slice(1);
  expect(rows.map((row) => row.lastElementChild?.textContent)).toEqual([
    new Date("2026-11-17T20:30:25.000Z").toLocaleTimeString(),
    new Date(1794947420913).toLocaleTimeString(),
  ]);
});

test("Last seen adds the date when it is not today", () => {
  const seenAt = new Date("2026-11-10T09:15:00.000Z");
  render(
    <SdkInventory
      items={decodeEnvelope(
        JSON.stringify([
          { sdk: { name: "sentry.ruby.rails", version: "5.22.0" } },
          [[{ type: "event" }, { timestamp: seenAt.getTime() / 1000 }]],
        ]),
        "rails",
      )}
    />,
  );
  expect(screen.getAllByRole("row")[1]?.lastElementChild?.textContent).toBe(
    `${seenAt.toLocaleDateString()} ${seenAt.toLocaleTimeString()}`,
  );
});
