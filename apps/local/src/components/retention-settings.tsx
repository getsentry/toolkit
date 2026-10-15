import { type FormEvent, useEffect, useState } from "react";
import {
  isValidMaxEnvelopes,
  MAX_ENVELOPES,
} from "../../../../packages/cli/src/commands/local/retention-limits.ts";

type Props = {
  limit: number;
  count: number;
  streamUrl: string;
  editable: boolean;
  unavailableReason?: string;
};
/** Envelope-count controls keep existing viewer state and the EventSource intact. */
export function RetentionSettings({
  limit,
  count,
  streamUrl,
  editable,
  unavailableReason,
}: Props) {
  const [draft, setDraft] = useState(String(limit));
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(String(limit)), [limit]);
  async function save(event: FormEvent) {
    event.preventDefault();
    const value = /^\d+$/.test(draft) ? Number(draft) : NaN;
    if (!isValidMaxEnvelopes(value)) {
      setError(`Enter an integer between 1 and ${MAX_ENVELOPES}.`);
      return;
    }
    if (value < count) {
      setError(
        `Cannot lower the limit below ${count} displayed envelopes. Clear envelopes first.`,
      );
      return;
    }
    const url = new URL(streamUrl);
    url.pathname = /^\/_local\/v1\/sessions\/[^/]+\/stream$/.test(url.pathname)
      ? url.pathname.replace(/\/stream$/, "/ui/retention")
      : "/retention";
    setSaving(true);
    setError(undefined);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxEnvelopes: value }),
        signal: AbortSignal.timeout(5000),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        const detail =
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof body.error === "string"
            ? body.error
            : "Could not update retention. Existing envelopes were preserved.";
        setError(detail);
        return;
      }
      if (
        typeof body !== "object" ||
        body === null ||
        !("maxEnvelopes" in body) ||
        !isValidMaxEnvelopes(body.maxEnvelopes)
      )
        throw new Error("Invalid retention response");
      // Ordered stream metadata is authoritative. A delayed HTTP response must
      // not overwrite a newer CLI change or a different receiver's settings.
    } catch {
      setError(
        "Could not update retention. Existing envelopes were preserved.",
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <details className="shrink-0 border-b border-border px-4 py-2 text-sm">
      <summary className="cursor-pointer text-muted-foreground">
        Retention limit: {limit.toLocaleString()} envelopes ·{" "}
        {count.toLocaleString()} displayed
      </summary>
      {editable ? (
        <form
          onSubmit={save}
          className="mt-2 flex flex-wrap items-center gap-2"
        >
          <label htmlFor="retention-limit">Retention limit</label>
          <input
            id="retention-limit"
            type="number"
            min={1}
            max={MAX_ENVELOPES}
            step={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="h-8 w-28 border border-border bg-background px-2"
          />
          <button
            type="submit"
            disabled={saving}
            className="h-8 bg-primary px-3 text-primary-foreground disabled:opacity-50"
          >
            {saving ? "Applying…" : "Apply retention limit"}
          </button>
          <p className="w-full text-xs text-muted-foreground">
            Existing envelopes stay available. A lower limit requires clearing
            enough envelopes first.
          </p>
          {error ? (
            <p role="alert" className="w-full text-destructive">
              {error}
            </p>
          ) : null}
        </form>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          {unavailableReason ??
            "Change retention from a locally served viewer or the CLI."}
        </p>
      )}
    </details>
  );
}
