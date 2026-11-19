import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../sentry-docs/fetcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sentry-docs/fetcher")>()),
  fetchDocPage: vi.fn().mockResolvedValue("# JavaScript"),
}));

import { FALLBACK_MODEL, PRIMARY_MODEL } from "../agent/model-fallback";
import {
  runTailorAgent,
  setSynthesizedMarkdownAttributes,
} from "../agent/tailor-agent";
import { stubOpenRouter } from "./openrouter-stub";

afterEach(() => {
  vi.unstubAllGlobals();
});

const fetchStep = (id: string) => ({
  toolCalls: [
    { id, input: { path: "/platforms/javascript/" }, name: "fetch_doc_page" },
  ],
});

describe("setSynthesizedMarkdownAttributes", () => {
  test("stores the complete markdown without truncating it", () => {
    const attributes = new Map<string, number | string>();
    const markdown = `# Tailored guide\n\n${"full markdown ".repeat(5000)}`;

    setSynthesizedMarkdownAttributes(
      {
        setAttribute(name, value) {
          attributes.set(name, value);
        },
      },
      markdown,
    );

    expect(attributes.get("docs.synthesized_markdown")).toBe(markdown);
    expect(attributes.get("docs.synthesized_markdown_chars")).toBe(
      markdown.length,
    );
  });
});

describe("runTailorAgent", () => {
  test("forces toolChoice none on the last step", async () => {
    const requests = stubOpenRouter({
      [PRIMARY_MODEL]: [
        ...Array.from({ length: 9 }, (_, index) => fetchStep(`c${index}`)),
        { text: "# Guide" },
      ],
    });

    await expect(
      runTailorAgent("sk-or-test", ["javascript"], []),
    ).resolves.toBe("# Guide");
    expect(requests).toHaveLength(10);
    expect(requests.map((request) => request.tool_choice)).toEqual([
      ...Array.from({ length: 9 }, () => "auto"),
      "none",
    ]);
    expect(requests[9]!.tools).toHaveLength(2);
  });

  test("synthesizes from the tool history when the agent ends without text", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const requests = stubOpenRouter({
      [PRIMARY_MODEL]: [
        fetchStep("c1"),
        { text: "" },
        { message: "bad request", status: 400 },
      ],
      [FALLBACK_MODEL]: [{ text: "# Synthesized guide" }],
    });

    await expect(
      runTailorAgent("sk-or-test", ["javascript"], []),
    ).resolves.toBe("# Synthesized guide");

    const synthesis = requests.slice(2);
    expect(synthesis.map((request) => request.model)).toEqual([
      PRIMARY_MODEL,
      FALLBACK_MODEL,
    ]);
    expect(synthesis[1]!.tool_choice).toBe("none");
    expect(synthesis[1]!.tools).toHaveLength(2);
    expect(synthesis[1]!.messages.map((message) => message.role)).toEqual([
      "system",
      "assistant",
      "tool",
      "user",
    ]);
  });
});
