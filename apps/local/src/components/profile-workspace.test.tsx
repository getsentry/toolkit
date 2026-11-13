import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { decodeEnvelope } from "../lib/spotlight.ts";
import { ProfileWorkspace } from "./profile-workspace.tsx";

afterEach(cleanup);
const chunk = (id: string, name: string, start: number) =>
  decodeEnvelope(
    JSON.stringify([
      {},
      [
        [
          { type: "profile_chunk" },
          {
            chunk_id: id,
            profiler_id: "profiler",
            profile: {
              frames: [{ function: name }],
              stacks: [[0]],
              samples: [start, start + 0.01].map((timestamp) => ({
                thread_id: "main",
                stack_id: 0,
                timestamp,
              })),
            },
          },
        ],
      ],
    ]),
    id,
  )[0]!;

test("profile overview combines retained session chunks and keeps a single-chunk scope", () => {
  const first = chunk("a", "first", 1),
    second = chunk("b", "second", 1.02);
  render(
    <ProfileWorkspace
      items={[first, second]}
      traces={[]}
      query=""
      selectedId={first.id}
      onSelect={vi.fn()}
      onSelectTrace={vi.fn()}
    />,
  );
  expect(screen.getByText(/4 samples/)).toBeDefined();
  expect(
    within(screen.getByRole("table", { name: "Profile functions" })).getByText(
      "second",
    ),
  ).toBeDefined();
  fireEvent.change(screen.getByRole("combobox", { name: "Profile scope" }), {
    target: { value: "chunk" },
  });
  expect(screen.getByText(/2 samples/)).toBeDefined();
  expect(
    within(
      screen.getByRole("table", { name: "Profile functions" }),
    ).queryByText("second"),
  ).toBeNull();
});

test("profile overview refreshes functions after a late chunk while the original selection remains", () => {
  const first = chunk("a", "first", 1),
    second = chunk("b", "second", 1.02);
  const props = {
    traces: [],
    query: "",
    selectedId: first.id,
    onSelect: vi.fn(),
    onSelectTrace: vi.fn(),
  };
  const view = render(<ProfileWorkspace {...props} items={[first]} />);
  expect(screen.getByText(/2 samples/)).toBeDefined();
  view.rerender(<ProfileWorkspace {...props} items={[first, second]} />);
  expect(screen.getByText(/4 samples/)).toBeDefined();
  expect(
    within(screen.getByRole("table", { name: "Profile functions" })).getByText(
      "second",
    ),
  ).toBeDefined();
});
