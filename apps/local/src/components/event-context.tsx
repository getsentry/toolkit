import { record, display, text, feedbackData } from "@/lib/inspection.ts";
import type { LocalFeedItem } from "@/lib/spotlight.ts";
import { DetailFields } from "./span-detail.tsx";
import { attributeFields } from "./inspector-data.ts";

export function EventContext({ payload }: { payload: unknown }) {
  const p = record(payload);
  const breadcrumbs = Array.isArray(p.breadcrumbs)
    ? p.breadcrumbs
    : record(p.breadcrumbs).values;
  const sections = ["request", "contexts", "tags", "extra", "modules"] as const;
  return (
    <div className="space-y-3">
      {Array.isArray(breadcrumbs) && breadcrumbs.length ? (
        <section aria-label="Breadcrumbs" className="space-y-2">
          <h3 className="text-sm font-semibold">Breadcrumbs</h3>
          <ol className="divide-y divide-border border-l-2 border-border pl-3">
            {breadcrumbs.map((value, index) => {
              const crumb = record(value);
              return (
                <li key={index} className="space-y-1 py-2">
                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <span>
                      {text(crumb.category) ?? text(crumb.type) ?? "Breadcrumb"}
                    </span>
                    <span>{text(crumb.level)}</span>
                    <time>
                      {crumb.timestamp === undefined
                        ? ""
                        : display(crumb.timestamp)}
                    </time>
                  </div>
                  {crumb.message !== undefined ? (
                    <p className="whitespace-pre-wrap break-words text-sm">
                      {display(crumb.message)}
                    </p>
                  ) : null}
                  {Object.keys(record(crumb.data)).length ? (
                    <DetailFields
                      label={`Breadcrumb ${index + 1} data`}
                      fields={attributeFields(crumb.data)}
                    />
                  ) : null}
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}
      {sections.map((key) =>
        Object.keys(record(p[key])).length ? (
          <details key={key} open className="border-t border-border pt-2">
            <summary className="cursor-pointer text-sm font-semibold capitalize">
              {key === "extra" ? "Additional data" : key}
            </summary>
            {key === "contexts" ? (
              Object.entries(record(p.contexts)).map(([name, context]) => (
                <section
                  key={name}
                  className="mt-2 border-l border-border pl-3"
                >
                  <h4 className="text-xs font-medium capitalize">{name}</h4>
                  <DetailFields
                    label={`${name} context`}
                    fields={attributeFields(context)}
                  />
                </section>
              ))
            ) : (
              <DetailFields
                label={`Event ${key}`}
                fields={attributeFields(p[key])}
              />
            )}
          </details>
        ) : null,
      )}
    </div>
  );
}
export function FeedbackInspector({
  item,
  items = [],
  onSelect,
}: {
  item: LocalFeedItem;
  items?: readonly LocalFeedItem[];
  onSelect?: (item: LocalFeedItem) => void;
}) {
  const feedback = feedbackData(item.payload);
  const associatedId =
    text(feedback.associated_event_id) ??
    (item.type === "user_report" ? text(feedback.event_id) : undefined);
  const associated = associatedId
    ? items.find(
        (candidate) =>
          candidate.type === "event" &&
          record(candidate.payload).event_id === associatedId,
      )
    : undefined;
  return (
    <section aria-label="Feedback details" className="space-y-3">
      <h3 className="text-sm font-semibold">User feedback</h3>
      <DetailFields
        label="Feedback fields"
        fields={Object.entries({
          Message: feedback.message ?? feedback.comments,
          Name: feedback.name,
          Email: feedback.contact_email ?? feedback.email,
          Page: feedback.url,
          Source: feedback.source,
          "Associated event ID": associatedId,
        }).flatMap(([label, value]) =>
          value === undefined ? [] : [{ label, value: display(value) }],
        )}
      />
      {associated && onSelect ? (
        <button
          type="button"
          className="text-sm text-primary underline"
          onClick={() => onSelect(associated)}
        >
          View associated error · {associated.metadata?.title ?? associatedId}
        </button>
      ) : associatedId ? (
        <p className="text-xs text-muted-foreground">
          The associated event is not in this capture.
        </p>
      ) : null}
    </section>
  );
}
