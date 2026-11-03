import { afterEach, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { getEventExceptions } from "@/lib/exceptions.ts";
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
