/**
 * Markdown component that makes slash commands clickable
 */
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/client/lib/utils";
import { Markdown } from "./markdown";

interface InteractiveMarkdownProps {
  children: string;
  className?: string;
  hasSlashCommands?: boolean;
  onSlashCommand?: (command: string) => void;
}

export function InteractiveMarkdown({
  children,
  className,
  hasSlashCommands,
  onSlashCommand,
}: InteractiveMarkdownProps) {
  // If this content has slash commands and we have a handler, create custom renderer
  if (hasSlashCommands && onSlashCommand) {
    return (
      <ReactMarkdown
        className={cn(
          "prose prose-invert prose-slate max-w-none",
          "prose-p:my-2 prose-p:leading-relaxed",
          "prose-pre:bg-slate-900 prose-pre:border prose-pre:border-slate-700",
          "prose-code:bg-slate-800 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-sm",
          "prose-code:before:content-none prose-code:after:content-none",
          "prose-strong:text-slate-100",
          "prose-em:text-slate-200",
          "prose-a:text-violet-300",
          "prose-blockquote:border-l-violet-500 prose-blockquote:bg-slate-800/50 prose-blockquote:py-2 prose-blockquote:px-4",
          "prose-h1:text-slate-100 prose-h2:text-slate-100 prose-h3:text-slate-100",
          "prose-h4:text-slate-100 prose-h5:text-slate-100 prose-h6:text-slate-100",
          "prose-ul:my-2 prose-ol:my-2",
          "prose-li:my-1",
          "prose-hr:border-slate-700",
          "prose-table:border-slate-700",
          "prose-th:border-slate-700 prose-td:border-slate-700",
          className,
        )}
        remarkPlugins={[remarkGfm]}
        disallowedElements={["script", "style", "iframe", "object", "embed"]}
        unwrapDisallowed={true}
        components={{
          // Custom renderer for code that might contain slash commands
          code: ({ children, ref, ...props }) => {
            const text = typeof children === "string" ? children : "";
            if (text.startsWith("/") && text.match(/^\/[a-zA-Z]+$/)) {
              // This is a slash command, make it clickable
              const command = text.slice(1);
              return (
                <button
                  onClick={() => onSlashCommand(command)}
                  className="inline-flex items-center gap-1 px-1 py-0.5 text-xs bg-blue-900/50 border border-blue-700/50 rounded text-blue-300 hover:bg-blue-800/50 hover:border-blue-600/50 transition-colors font-mono cursor-pointer"
                  type="button"
                  {...props}
                >
                  {text}
                </button>
              );
            }
            // Regular code rendering
            return (
              <code ref={ref as any} {...props}>
                {children}
              </code>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    );
  }

  // Otherwise, render as normal markdown
  return <Markdown className={className}>{children}</Markdown>;
}
