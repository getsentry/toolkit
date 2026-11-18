import { vi } from "vitest";

type OpenRouterReply =
  | {
      text?: string;
      toolCalls?: Array<{ id: string; input: unknown; name: string }>;
    }
  | { headers?: Record<string, string>; message: string; status: number }
  | { reject: Error };

export interface OpenRouterRequest {
  messages: Array<{ content: unknown; role: string }>;
  model: string;
  response_format?: { type: string };
  temperature?: number;
  tool_choice?: unknown;
  tools?: unknown[];
}

/**
 * Replace `fetch` with a fake OpenRouter chat completions API that answers
 * each model with its scripted replies in order. Returns the request bodies.
 */
export function stubOpenRouter(
  replies: Record<string, OpenRouterReply[]>,
): OpenRouterRequest[] {
  const requests: OpenRouterRequest[] = [];
  vi.stubGlobal("fetch", (_url: string, init: { body: string }) => {
    const request = JSON.parse(init.body) as OpenRouterRequest;
    requests.push(request);
    const reply = replies[request.model]?.shift() ?? {
      message: `No reply scripted for ${request.model}`,
      status: 500,
    };
    if ("reject" in reply) {
      return Promise.reject(reply.reject);
    }
    if ("status" in reply) {
      return Promise.resolve(
        Response.json(
          { error: { code: reply.status, message: reply.message } },
          { headers: reply.headers, status: reply.status },
        ),
      );
    }
    const toolCalls = (reply.toolCalls ?? []).map((call) => ({
      function: { arguments: JSON.stringify(call.input), name: call.name },
      id: call.id,
      type: "function",
    }));
    return Promise.resolve(
      Response.json({
        choices: [
          {
            finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
            index: 0,
            message: {
              content: reply.text || null,
              role: "assistant",
              ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            },
          },
        ],
        created: 1,
        id: "gen-test",
        model: request.model,
        usage: { completion_tokens: 5, prompt_tokens: 10, total_tokens: 15 },
      }),
    );
  });
  return requests;
}
