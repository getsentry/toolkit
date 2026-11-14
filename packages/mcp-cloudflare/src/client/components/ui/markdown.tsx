import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/client/lib/utils";

interface MarkdownProps {
  children: string;
  className?: string | undefined;
}

export function Markdown({ children, className }: MarkdownProps) {
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
    >
      {children}
    </ReactMarkdown>
  );
}
