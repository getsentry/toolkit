import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { decodeEnvelope } from "@/lib/spotlight.ts";
import { SdkInventory } from "./sdk-inventory.tsx";

afterEach(cleanup);

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
