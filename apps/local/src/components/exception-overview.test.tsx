import { afterEach, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { getEventExceptions } from "@/lib/exceptions.ts";
import { getEventMetadata } from "@/lib/spotlight.ts";
import { ExceptionOverview } from "./exception-overview.tsx";

afterEach(cleanup);

test("renders exception messages and source as escaped text", () => {
  const value = '<img src=x onerror="alert(1)">';
  const source = '<script>alert("stack")</script>';
  const { container } = render(
    <ExceptionOverview
      exceptions={getEventExceptions({
        exception: {
          values: [
            {
              type: "Error",
              value,
              stacktrace: {
                frames: [
                  {
                    filename: "/app/view.ts",
                    function: "render",
                    context_line: source,
                  },
                ],
              },
            },
          ],
        },
      })}
    />,
  );
  expect(
    screen.getByRole("heading", { name: `Error: ${value}` }),
  ).not.toBeNull();
  expect(screen.getByText(source)).not.toBeNull();
  expect(container.querySelector("script, img")).toBeNull();
});

test("titles a coloured event message like the list, without ANSI escapes", () => {
  const event = {
    message: "\u001b[31mCheckout retry limit reached\u001b[0m",
    exception: { values: [{ value: "Checkout retry limit reached" }] },
  };
  const listTitle = getEventMetadata(event, "event").title;
  expect(listTitle).toBe("Checkout retry limit reached");
  render(<ExceptionOverview exceptions={getEventExceptions(event)} />);
  expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(listTitle);
  expect(event.message).toContain("\u001b[31m");
});

test("explains when the SDK supplied an exception without frames", () => {
  render(
    <ExceptionOverview
      exceptions={getEventExceptions({
        exception: { values: [{ value: "Request rejected" }] },
      })}
    />,
  );
  expect(
    screen.getByRole("heading", { name: "Request rejected" }),
  ).not.toBeNull();
  expect(screen.getByText("No stack trace captured.")).not.toBeNull();
});

test("does not label unrelated or aggregate SDK exceptions as a cause", () => {
  render(
    <ExceptionOverview
      exceptions={getEventExceptions({
        exception: {
          values: [
            {
              type: "Error",
              value: "One request failed",
              mechanism: { source: "errors[0]" },
            },
            { type: "AggregateError", value: "Several requests failed" },
          ],
        },
      })}
    />,
  );
  expect(screen.getByText("Additional exception")).not.toBeNull();
  expect(screen.queryByText("Caused by")).toBeNull();
});
