import { Copy, Check } from "lucide-react";
import { useState, useEffect, useRef } from "react";
import { Button } from "./button";

export default function CodeSnippet({
  snippet,
  noMargin,
}: {
  snippet: string;
  noMargin?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  // Clean up timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      // Only show success if the operation actually succeeded
      setCopied(true);

      // Clear any existing timeout before setting a new one
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      timeoutRef.current = setTimeout(() => {
        setCopied(false);
        timeoutRef.current = null;
      }, 2000);
    } catch (error) {
      // Handle clipboard write failure silently or you could show an error state
      console.error("Failed to copy to clipboard:", error);
    }
  };

  return (
    <div className={`relative text-white max-w-full ${!noMargin && "mb-6"}`}>
      <div className="absolute top-2.5 right-2.5 flex items-center justify-end">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-neutral-500 cursor-pointer duration-300 hover:bg-violet-300/25 rounded-md focus:!ring-violet-300/50 group/copy"
          onClick={() => {
            void handleCopy();
          }}
        >
          {copied ? (
            <Check className="h-4 w-4 text-green-500" />
          ) : (
            <Copy className="h-4 w-4 text-violet-300/50 group-focus/copy:text-violet-300" />
          )}
          <span className="sr-only">Copy Snippet</span>
        </Button>
      </div>
      <pre
        className="p-4 border border-violet-300/25 pr-12 overflow-x-auto text-slate-200 text-sm bg-background rounded-xl"
        style={{ margin: 0 }}
      >
        {snippet}
      </pre>
    </div>
  );
}
