import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { decodeEnvelope } from "../lib/spotlight.ts";
import { aiItems, sdkInventory } from "../lib/inspection.ts";
import { EventDetail } from "./event-detail.tsx";
import { AttachmentDetail } from "./attachment-detail.tsx";
import { attachmentBytes } from "../lib/attachments.ts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const decode = (type: string, payload: unknown) =>
  decodeEnvelope(
    JSON.stringify([
      { sdk: { name: "sentry.javascript.node", version: "10.0" } },
      [[{ type }, payload]],
    ]),
    "test",
  )[0]!;

test("errors expose captured breadcrumbs, contexts, locals and editor actions", () => {
  render(
    <EventDetail
      item={decode("event", {
        level: "error",
        message: "Checkout failed",
        breadcrumbs: [{ category: "navigation", message: "Opened checkout" }],
        contexts: { browser: { name: "Firefox" } },
        tags: { region: "test" },
        exception: {
          values: [
            {
              type: "Error",
              value: "Oops",
              stacktrace: {
                frames: [
                  {
                    function: "checkout",
                    abs_path: "/app/checkout.ts",
                    lineno: 12,
                    vars: { cartSize: 2 },
                  },
                ],
              },
            },
          ],
        },
      })}
    />,
  );
  expect(screen.getByText("Opened checkout")).toBeDefined();
  expect(screen.getByText("Firefox")).toBeDefined();
  expect(screen.getByText("cartSize")).toBeDefined();
  expect(
    screen.getByRole("link", { name: /Open in VS Code/ }).getAttribute("href"),
  ).toContain("checkout.ts:12");
  expect(screen.getByRole("button", { name: "Copy for AI" })).toBeDefined();
});

test("AI includes embedded spans with readable conversation and tool execution", () => {
  const item = decode("transaction", {
    contexts: { trace: { trace_id: "trace", span_id: "root" } },
    spans: [
      {
        span_id: "chat",
        op: "gen_ai.chat",
        description: "Assistant turn",
        data: {
          "gen_ai.request.model": "test-model",
          "gen_ai.usage.input_tokens": 42,
          "gen_ai.request.messages": JSON.stringify([
            { role: "user", content: "Find my order" },
          ]),
          "gen_ai.response.text": "Order found",
          "gen_ai.response.tool_calls": JSON.stringify([
            { name: "find_order", arguments: { id: 12 } },
          ]),
        },
      },
    ],
  });
  const [ai] = aiItems([item]);
  expect(ai).toBeDefined();
  render(<EventDetail item={ai!} />);
  expect(screen.getByText("test-model")).toBeDefined();
  expect(screen.getByText("Find my order")).toBeDefined();
  expect(screen.getByText("Order found")).toBeDefined();
  expect(screen.getByText("find_order")).toBeDefined();
  expect(screen.getByText("42")).toBeDefined();
});

test("feedback reads modern contexts.feedback and links to associated captured error", () => {
  const error = decode("event", {
    event_id: "error-id",
    level: "error",
    message: "Oops",
  });
  const feedback = decode("feedback", {
    contexts: {
      feedback: {
        message: "Checkout is broken",
        contact_email: "test@example.com",
        associated_event_id: "error-id",
      },
    },
  });
  const onSelect = vi.fn();
  render(
    <EventDetail
      item={feedback}
      relatedItems={[error]}
      onSelectRelatedItem={onSelect}
    />,
  );
  expect(
    screen.getByRole("region", { name: "Feedback details" }).textContent,
  ).toContain("Checkout is broken");
  fireEvent.click(
    screen.getByRole("button", { name: /View associated error/ }),
  );
  expect(onSelect).toHaveBeenCalledWith(error);
});

test("attachments preserve filename and display HTML as inert source", () => {
  const [attachment] = decodeEnvelope(
    JSON.stringify([
      {},
      [
        [
          {
            type: "attachment",
            filename: "report.html",
            content_type: "text/html",
          },
          { data: "<script>alert(1)</script>" },
        ],
      ],
    ]),
    "attachment",
  );
  render(<AttachmentDetail item={attachment!} />);
  expect(screen.getByText("report.html")).toBeDefined();
  expect(screen.getByText("<script>alert(1)</script>")).toBeDefined();
  expect(document.querySelector("script")).toBeNull();
});

test("SDK inventory discovers envelope SDK metadata without client reports", () => {
  const entries = sdkInventory([
    decode("event", { platform: "javascript" }),
    decode("log", { body: "test" }),
  ]);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    name: "sentry.javascript.node",
    version: "10.0",
    count: 2,
  });
});

test("binary and charset attachment payloads retain receiver-encoded bytes", () => {
  const [binary] = decodeEnvelope(
    JSON.stringify([
      {},
      [
        [
          {
            type: "attachment",
            filename: "file.bin",
            content_type: "application/octet-stream",
          },
          { data: "AP9B" },
        ],
      ],
    ]),
    "binary",
  );
  expect([...attachmentBytes(binary!)!.bytes]).toEqual([0, 255, 65]);
  const [text] = decodeEnvelope(
    JSON.stringify([
      {},
      [
        [
          { type: "attachment", content_type: "text/plain; charset=utf-8" },
          { data: "aGVsbG8=" },
        ],
      ],
    ]),
    "text",
  );
  expect(new TextDecoder().decode(attachmentBytes(text!)!.bytes)).toBe("hello");
});

test("minimal span-v2 AI operations remain visible with honest missing-content details", () => {
  const item = decode("span", {
    version: 2,
    items: [
      {
        trace_id: "t",
        span_id: "s",
        start_timestamp: 1,
        end_timestamp: 2,
        attributes: { "sentry.op": { type: "string", value: "gen_ai.chat" } },
      },
    ],
  });
  expect(item.metadata?.operation).toBe("gen_ai.chat");
  expect(aiItems([item])).toEqual([item]);
  render(<EventDetail item={item} />);
  expect(
    screen.getByRole("region", { name: "AI interaction" }).textContent,
  ).toContain("Prompt and response content were not captured");
});

test("legacy user reports associate by event_id even when the report arrives first", () => {
  const error = decode("event", {
    event_id: "error-id",
    level: "error",
    message: "Oops",
  });
  const feedback = decode("user_report", {
    event_id: "error-id",
    comments: "Broken checkout",
    name: "Test",
    email: "test@example.com",
  });
  const onSelect = vi.fn();
  render(
    <EventDetail
      item={feedback}
      relatedItems={[feedback, error]}
      onSelectRelatedItem={onSelect}
    />,
  );
  expect(
    screen.getByRole("region", { name: "Feedback details" }).textContent,
  ).toContain("Broken checkout");
  fireEvent.click(
    screen.getByRole("button", { name: /View associated error/ }),
  );
  expect(onSelect).toHaveBeenCalledWith(error);
});

test("AI origin metadata remains visible when the SDK did not capture content", () => {
  const [span] = decodeEnvelope(
    JSON.stringify([
      {},
      [
        [
          { type: "span" },
          {
            version: 2,
            items: [
              {
                trace_id: "trace",
                span_id: "origin-only",
                start_timestamp: 1,
                end_timestamp: 2,
                attributes: {
                  "sentry.origin": { type: "string", value: "auto.ai.vercel" },
                },
              },
            ],
          },
        ],
      ],
    ]),
    "origin",
  );
  expect(aiItems([span!])).toHaveLength(1);
  render(<EventDetail item={span!} />);
  expect(
    screen.getByText(/Prompt and response content were not captured/),
  ).toBeDefined();
});

test.each([
  ["image/svg+xml", false, "application/octet-stream"],
  ["application/xhtml+xml", false, "application/octet-stream"],
  ["text/html", true, "text/plain"],
  ["image/png", false, "image/png"],
] as const)(
  "%s downloads use an inert or allowlisted Blob MIME type",
  (contentType, wireText, expectedType) => {
    const content =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>window.svgExecuted = true</script></svg>';
    const [item] = decodeEnvelope(
      JSON.stringify([
        {},
        [
          [
            {
              type: "attachment",
              filename: "capture.svg",
              content_type: contentType,
            },
            { data: wireText ? content : btoa(content) },
          ],
        ],
      ]),
      "mime",
    );
    const create = vi.fn((_blob: Blob) => "blob:attachment");
    class TestURL extends URL {
      static createObjectURL = create;
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal("URL", TestURL);
    render(<AttachmentDetail item={item!} />);
    expect(create.mock.calls[0]?.[0].type).toBe(expectedType);
    expect(document.querySelector("script")).toBeNull();
  },
);

test("raw SSE envelopes show attachment previews and keep the original JSON", () => {
  const raw = JSON.stringify([
    {},
    [
      [
        {
          type: "attachment",
          filename: "notes.txt",
          content_type: "text/plain",
        },
        { data: "captured notes" },
      ],
    ],
  ]);
  render(
    <EventDetail
      item={{ id: "envelope", type: "envelope", payload: raw, text: raw }}
    />,
  );
  expect(
    screen.getByRole("region", { name: "Envelope attachments" }).textContent,
  ).toContain("captured notes");
  fireEvent.click(screen.getByRole("tab", { name: "JSON" }));
  expect(screen.getByTestId("highlighted-json").textContent).toContain(
    "notes.txt",
  );
});
