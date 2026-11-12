import { useState } from "react";
import { Bolt, ChevronDown, ChevronRight } from "lucide-react";
import type { ToolMessage, ToolInvocationProps } from "./types";
import { isTextMessage } from "./types";

function getTokenCount(content: ToolMessage[]): number {
  return content.reduce((acc, message) => {
    if (isTextMessage(message)) {
      return acc + message.text.length;
    }
    return acc;
  }, 0);
}

export function ToolInvocation({ tool }: ToolInvocationProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="border border-slate-900 rounded overflow-hidden">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full p-3 text-left cursor-pointer hover:bg-slate-900/50 transition-colors"
      >
        <div className="flex items-center gap-2 text-violet-400">
          {isExpanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
          <Bolt className="h-3 w-3" />
          <span className="font-mono">{tool.toolName}</span>
          {tool.state === "result" && (
            <span className="text-xs text-slate-500 ml-auto">
              {`~${getTokenCount(tool.result?.content ?? []).toLocaleString()}
              tokens`}
            </span>
          )}
        </div>
      </button>

      {isExpanded && tool.state === "result" && tool.result && (
        <div className="px-3 pb-3 border-t border-slate-600/30 text-slate-300">
          <div className="mt-2">
            <ToolContent content={tool.result.content} />
          </div>
        </div>
      )}
    </div>
  );
}

export function ToolContent({ content }: { content: ToolMessage[] }) {
  return (
    <div className="space-y-3">
      {content.map((message: ToolMessage, index: number) => (
        <div key={`message-${message.type}-${index}`} className="space-y-2">
          <pre className="text-slate-400 text-sm whitespace-pre-wrap overflow-x-auto">
            {isTextMessage(message)
              ? message.text
              : JSON.stringify(message, null, 2)}
          </pre>
        </div>
      ))}
    </div>
  );
}
