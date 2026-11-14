/**
 * Component for rendering a readable list of tools
 */

export interface ToolInfo {
  name: string;
  description: string;
}

interface ToolActionsProps {
  tools: ToolInfo[];
}

export function ToolActions({ tools }: ToolActionsProps) {
  if (tools.length === 0) return null;

  return (
    <div className="mt-4 space-y-3">
      <h4 className="text-sm font-medium text-slate-300 mb-2">Skills</h4>
      <div className="space-y-4">
        {tools.map((tool) => (
          <div key={tool.name} className="space-y-2">
            <div className="inline-block rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] font-mono text-slate-200">
              <code>{tool.name}</code>
            </div>
            {tool.description ? (
              <p className="text-xs text-slate-400 ml-1">{tool.description}</p>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
