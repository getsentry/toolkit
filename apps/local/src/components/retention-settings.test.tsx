import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { RetentionSettings } from "./retention-settings.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("validates retention with an accessible field error before sending mutations", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  render(
    <RetentionSettings
      limit={500}
      count={8}
      streamUrl="http://127.0.0.1:8969/stream"
      editable
    />,
  );
  const input = screen.getByLabelText("Retention limit");
  fireEvent.change(input, { target: { value: "1.5" } });
  fireEvent.click(
    screen.getByRole("button", { name: "Apply retention limit" }),
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Enter an integer between 1 and 50,000",
  );
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(fetch).not.toHaveBeenCalled();
});

test("reports a receiver-side retention race without claiming a successful save", async () => {
  const fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        error: "Cannot lower the limit below 9 retained envelopes.",
      }),
      { status: 409 },
    ),
  );
  vi.stubGlobal("fetch", fetch);
  render(
    <RetentionSettings
      limit={500}
      count={8}
      streamUrl="http://127.0.0.1:8969/_local/v1/sessions/web/stream?cap=test"
      editable
    />,
  );
  fireEvent.change(screen.getByLabelText("Retention limit"), {
    target: { value: "8" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Apply retention limit" }),
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "9 retained envelopes",
  );
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Apply retention limit",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  expect(fetch).toHaveBeenCalledWith(
    new URL(
      "http://127.0.0.1:8969/_local/v1/sessions/web/ui/retention?cap=test",
    ),
    expect.objectContaining({ body: '{"maxEnvelopes":8}' }),
  );
  expect(
    (screen.getByLabelText("Retention limit") as HTMLInputElement).value,
  ).toBe("8");
  expect(screen.getByText("8 envelopes currently retained.")).not.toBeNull();
});

test.each([0, 1, 8])(
  "describes %i retained envelopes separately from the editable limit",
  (count) => {
    render(
      <RetentionSettings
        limit={500}
        count={count}
        streamUrl="http://127.0.0.1:8969/stream"
        editable
      />,
    );
    expect(
      screen.getByText(
        `${count} ${count === 1 ? "envelope" : "envelopes"} currently retained.`,
      ),
    ).not.toBeNull();
    expect(
      (
        screen.getByRole("spinbutton", {
          name: "Retention limit",
        }) as HTMLInputElement
      ).value,
    ).toBe("500");
    expect(screen.queryByText(/displayed/)).toBeNull();
  },
);

test.each([1, 1000])(
  "keeps capacity %i visible when the viewer cannot edit retention",
  (limit) => {
    render(
      <RetentionSettings
        limit={limit}
        count={8}
        streamUrl="http://127.0.0.1:8969/stream"
        editable={false}
      />,
    );
    expect(screen.getByText("Retention limit")).not.toBeNull();
    expect(
      screen.getByText(
        `${limit.toLocaleString()} ${limit === 1 ? "envelope" : "envelopes"}`,
      ),
    ).not.toBeNull();
    expect(screen.getByText("8 envelopes currently retained.")).not.toBeNull();
    expect(screen.queryByRole("spinbutton")).toBeNull();
  },
);
