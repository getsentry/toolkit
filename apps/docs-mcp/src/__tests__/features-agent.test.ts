import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../sentry-docs/fetcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sentry-docs/fetcher")>()),
  fetchDocPage: vi.fn().mockResolvedValue("# React"),
}));
vi.mock("../sentry-docs/doctree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sentry-docs/doctree")>()),
  searchPages: vi.fn().mockResolvedValue([
    {
      url: "https://docs.sentry.io/platforms/javascript/",
      title: "JS",
      description: "d",
    },
  ]),
}));

import { parseFeaturesOutput, runFeaturesAgent } from "../agent/features-agent";
import { PRIMARY_MODEL } from "../agent/model-fallback";
import { stubOpenRouter } from "./openrouter-stub";

afterEach(() => {
  vi.unstubAllGlobals();
});

const answer = (text: string, finishReason = "stop") => ({
  finishReason,
  text,
  toolCalls: [],
});
const toolStep = (text: string) => ({
  finishReason: "tool-calls",
  text,
  toolCalls: [{}],
});

describe("parseFeaturesOutput", () => {
  test("reads the last answer's JSON", async () => {
    await expect(
      parseFeaturesOutput([
        toolStep(""),
        answer('{"features":["tracing","logs"]}'),
      ]),
    ).resolves.toEqual({ features: ["tracing", "logs"] });
  });

  test("accepts prose around the JSON, a json code fence, and truncated JSON", async () => {
    await expect(
      parseFeaturesOutput([answer('Here you go: {"features":["logs"]}')]),
    ).resolves.toEqual({ features: ["logs"] });
    await expect(
      parseFeaturesOutput([answer('```json\n{"features":["logs"]}\n```')]),
    ).resolves.toEqual({ features: ["logs"] });
    await expect(
      parseFeaturesOutput([answer('{"features":["logs","tracing"')]),
    ).resolves.toEqual({ features: ["logs", "tracing"] });
  });

  test("skips tool steps and returns no output without an answer", async () => {
    await expect(
      parseFeaturesOutput([
        toolStep('Let me check. {"features":["logs"]}'),
        answer("  "),
      ]),
    ).resolves.toBeUndefined();
  });

  test("rejects an answer that does not match the schema", async () => {
    await expect(
      parseFeaturesOutput([answer("I could not find it.")]),
    ).rejects.toThrow(
      "Structured output validation failed: - root: Invalid input: expected object, received undefined",
    );
    await expect(
      parseFeaturesOutput([answer('{"feature":"logs"}')]),
    ).rejects.toThrow(
      "Structured output validation failed: - features: Invalid input: expected array, received undefined",
    );
  });

  test("rejects a step cut off by the length limit", async () => {
    await expect(
      parseFeaturesOutput([answer('{"features":["logs"', "length")]),
    ).rejects.toThrow(
      'Structured output was truncated because the model finished with reason "length".',
    );
  });
});

describe("runFeaturesAgent", () => {
  test("asks for the output schema on every step", async () => {
    const requests = stubOpenRouter({
      [PRIMARY_MODEL]: [
        {
          toolCalls: [
            {
              id: "c1",
              input: { path: "/platforms/javascript/guides/react/" },
              name: "fetch_doc_page",
            },
          ],
        },
        { text: '{"features":["tracing","bogus"]}' },
      ],
    });

    await expect(runFeaturesAgent("sk-or-test", ["react"])).resolves.toEqual([
      "error-monitoring",
      "tracing",
    ]);
    expect(requests.map((request) => request.response_format?.type)).toEqual([
      "json_schema",
      "json_schema",
    ]);
  });

  test("sends tool schemas, results, and input errors the way Mastra did", async () => {
    const requests = stubOpenRouter({
      [PRIMARY_MODEL]: [
        {
          toolCalls: [
            { id: "c1", input: {}, name: "fetch_doc_page" },
            { id: "c2", input: { query: "react" }, name: "search_docs" },
          ],
        },
        { text: '{"features":[]}' },
      ],
    });

    await runFeaturesAgent("sk-or-test", ["react"]);

    const tools = requests[0]!.tools as Array<{
      function: {
        name: string;
        parameters: { properties: Record<string, Record<string, unknown>> };
      };
    }>;
    const path = tools.find((tool) => tool.function.name === "fetch_doc_page")
      ?.function.parameters.properties["path"];
    expect(path?.["minLength"]).toBeUndefined();
    expect(path?.["description"]).toMatch(/\nconstraints: minimum length 1$/);

    const results = requests[1]!.messages.filter(
      (message) => message.role === "tool",
    );
    expect(
      results.map((message) => JSON.parse(String(message.content))),
    ).toEqual([
      {
        error: true,
        message:
          "Tool input validation failed for fetch_doc_page. Please fix the following errors and try again:\n- path: Invalid input: expected string, received undefined\n\nProvided arguments: {}",
        validationErrors: {
          errors: [],
          fields: {
            path: {
              errors: ["Invalid input: expected string, received undefined"],
              fields: {},
            },
          },
        },
      },
      {
        hits: [
          {
            description: "d",
            title: "JS",
            url: "https://docs.sentry.io/platforms/javascript/",
          },
        ],
      },
    ]);
    // Mastra sent the keys of tool results in sorted order.
    expect(results[1]!.content).toBe(
      '{"hits":[{"description":"d","title":"JS","url":"https://docs.sentry.io/platforms/javascript/"}]}',
    );
  });
});
