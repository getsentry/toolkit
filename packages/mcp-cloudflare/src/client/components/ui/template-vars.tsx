interface TemplateVarsProps {
  variables?: readonly string[] | null;
  title?: string;
}

/**
 * Renders a standardized Parameters box for template variables.
 */
export default function TemplateVars({
  variables,
  title = "Parameters",
}: TemplateVarsProps) {
  const vars = variables ?? [];
  if (vars.length === 0) return null;

  return (
    <section className="rounded-md border border-slate-700/60 bg-black/30 p-3">
      <div className="text-xs uppercase tracking-wide text-slate-300/80 mb-2">
        {title}
      </div>
      <div className="flex flex-wrap gap-2">
        {vars.map((v) => (
          <span
            key={v}
            className="inline-flex items-center rounded-full border border-violet-500/40 bg-violet-500/10 px-2 py-0.5 text-xs font-mono text-violet-200"
          >
            {v}
          </span>
        ))}
      </div>
    </section>
  );
}
