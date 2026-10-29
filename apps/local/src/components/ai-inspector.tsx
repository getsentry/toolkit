import type { TraceSpan } from "@/lib/trace-model.ts";
import {
  inspectAi,
  parsed,
  record,
  display,
  text,
  isAiPayload,
} from "@/lib/inspection.ts";
import { DetailFields } from "./span-detail.tsx";

function CapturedContent({ value }: { value: unknown }) {
  const rawContent = parsed(value);
  const content = record(rawContent).messages ?? rawContent;
  if (Array.isArray(content))
    return (
      <div className="space-y-2">
        {content.map((message, index) => {
          const entry = record(message);
          return (
            <div key={index} className="border-l-2 border-border pl-3">
              <p className="text-xs font-medium text-muted-foreground">
                {text(entry.role) ?? text(entry.type) ?? `Part ${index + 1}`}
              </p>
              <pre className="whitespace-pre-wrap break-words font-mono text-xs">
                {display(entry.content ?? entry.text ?? message)}
              </pre>
            </div>
          );
        })}
      </div>
    );
  return (
    <pre className="whitespace-pre-wrap break-words font-mono text-xs">
      {display(content)}
    </pre>
  );
}
export function AiInspector({
  payload,
  steps = [],
}: {
  payload: unknown;
  steps?: readonly TraceSpan[];
}) {
  const ai = inspectAi(payload);
  if (!ai) return null;
  const children: TraceSpan[] = [];
  const pending = [...steps];
  const seen = new Set<string>();
  while (pending.length) {
    const step = pending.shift()!;
    if (seen.has(step.id)) continue;
    seen.add(step.id);
    if (isAiPayload(step.payload)) children.push(step);
    else pending.push(...step.children);
  }
  return (
    <section aria-label="AI interaction" className="space-y-4">
      <h3 className="text-sm font-semibold">AI interaction</h3>
      <DetailFields label="AI details" fields={ai.fields} />
      {ai.system !== undefined ? (
        <section className="space-y-2">
          <h4 className="text-sm font-medium">System instructions</h4>
          <CapturedContent value={ai.system} />
        </section>
      ) : null}
      {ai.messages !== undefined ? (
        <section className="space-y-2">
          <h4 className="text-sm font-medium">Prompt</h4>
          <CapturedContent value={ai.messages} />
        </section>
      ) : null}
      {ai.response !== undefined ? (
        <section className="space-y-2">
          <h4 className="text-sm font-medium">Response</h4>
          <CapturedContent value={ai.response} />
        </section>
      ) : null}
      {ai.tools.length ? (
        <section className="space-y-2">
          <h4 className="text-sm font-medium">Tool calls</h4>
          {ai.tools.map((value, index) => {
            const tool = record(value),
              fn = record(tool.function);
            return (
              <section
                key={index}
                className="space-y-2 border border-border p-3"
              >
                <h5 className="break-words font-mono text-xs font-semibold">
                  {text(tool.name ?? tool.toolName ?? fn.name) ??
                    `Tool ${index + 1}`}
                </h5>
                <DetailFields
                  label={`Tool call ${index + 1}`}
                  fields={Object.entries({
                    ID: tool.id ?? tool.toolCallId,
                    Arguments: parsed(
                      tool.arguments ?? tool.args ?? fn.arguments,
                    ),
                    Result: parsed(tool.result ?? tool.output),
                  }).flatMap(([label, content]) =>
                    content === undefined
                      ? []
                      : [{ label, value: display(content), code: true }],
                  )}
                />
              </section>
            );
          })}
        </section>
      ) : null}
      {children.length ? (
        <section className="space-y-3 border-t border-border pt-3">
          <h4 className="text-sm font-medium">AI steps</h4>
          {children.map((step) => (
            <details
              key={step.id}
              open
              className="border-l-2 border-border pl-3"
            >
              <summary className="cursor-pointer break-words text-xs font-medium">
                {step.description}
              </summary>
              <AiInspector payload={step.payload} steps={step.children} />
            </details>
          ))}
        </section>
      ) : null}
      {ai.messages === undefined &&
      ai.response === undefined &&
      !ai.tools.length ? (
        <p className="text-xs text-muted-foreground">
          Prompt and response content were not captured. Check your SDK’s AI
          content recording settings.
        </p>
      ) : null}
    </section>
  );
}
