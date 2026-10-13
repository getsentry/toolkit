import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { JsonView } from "./json-view.tsx";

describe("JsonView", () => {
  test("formats valid JSON for a wrapped inspector", async () => {
    render(
      <JsonView
        code={'{"event_id":"event-1","context":{"route":"/api/users/42"}}'}
      />,
    );

    const inspector = screen.getByTestId("highlighted-json");

    await waitFor(() => {
      expect(inspector.textContent).toBe(
        '{\n  "event_id": "event-1",\n  "context": {\n    "route": "/api/users/42"\n  }\n}',
      );
    });
    expect(inspector.className).toContain("whitespace-pre-wrap");
    expect(inspector.className).toContain("break-words");
  });
});
