import { attributeFields } from "./inspector-data.ts";
import { DetailFields } from "./span-detail.tsx";
import { formatExceptionTitle, type EventException } from "@/lib/exceptions.ts";

/** Render SDK text as text, including source lines; never execute or fetch source. */
export function ExceptionOverview({
  exceptions,
}: {
  exceptions: EventException[];
}) {
  return (
    <div className="space-y-4">
      {exceptions.map((exception, index) => (
        <section
          key={index}
          aria-label={
            index === 0
              ? "Exception"
              : exception.isCause
                ? "Caused by"
                : "Additional exception"
          }
          className="space-y-2"
        >
          {index > 0 ? (
            <p className="text-xs font-semibold text-muted-foreground">
              {exception.isCause ? "Caused by" : "Additional exception"}
            </p>
          ) : null}
          <h3 className="whitespace-pre-wrap break-words font-mono text-sm font-semibold">
            {formatExceptionTitle(exception)}
          </h3>
          {exception.frames.length ? (
            <>
              <p className="text-xs text-muted-foreground">
                Stack trace · most recent call first
              </p>
              <ol
                aria-label="Stack frames"
                className="divide-y divide-border border border-border text-sm"
              >
                {exception.frames.map((frame, frameIndex) => (
                  <li key={frameIndex} className="space-y-1 p-3">
                    <code className="block break-words">{frame.function}</code>
                    <code className="block break-all text-xs text-muted-foreground">
                      {frame.filename}
                      {frame.line !== undefined
                        ? `:${frame.line}${frame.column !== undefined ? `:${frame.column}` : ""}`
                        : ""}
                    </code>
                    {(frame.editorPath ?? frame.filename).startsWith("/") ? (
                      <a
                        className="inline-block text-xs text-primary underline"
                        href={`vscode://file${encodeURI(frame.editorPath ?? frame.filename).replace(/[#?]/g, encodeURIComponent)}${frame.line === undefined ? "" : `:${frame.line}${frame.column === undefined ? "" : `:${frame.column}`}`}`}
                      >
                        Open in VS Code
                      </a>
                    ) : null}
                    {frame.variables ? (
                      <details open>
                        <summary className="cursor-pointer text-xs">
                          Local variables
                        </summary>
                        <DetailFields
                          label="Frame variables"
                          fields={attributeFields(frame.variables)}
                        />
                      </details>
                    ) : null}
                    {frame.source ? (
                      <pre className="overflow-x-auto whitespace-pre-wrap break-words bg-muted/40 p-2 text-xs">
                        <code>{frame.source}</code>
                      </pre>
                    ) : null}
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              No stack trace captured.
            </p>
          )}
        </section>
      ))}
    </div>
  );
}
