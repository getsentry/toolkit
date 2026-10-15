import { valibotResolver } from "@hookform/resolvers/valibot";
import { useForm } from "react-hook-form";
import * as v from "valibot";
import {
  isValidMaxEnvelopes,
  MAX_ENVELOPES,
} from "../../../../packages/cli/src/commands/local/retention-limits.ts";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";

type Props = {
  limit: number;
  count: number;
  streamUrl: string;
  editable: boolean;
  unavailableReason?: string;
};

/** Changes the selected session's limit without replacing its live stream. */
export function RetentionSettings({
  limit,
  count,
  streamUrl,
  editable,
  unavailableReason,
}: Props) {
  const invalidLimit = `Enter an integer between 1 and ${MAX_ENVELOPES.toLocaleString()}.`;
  const schema = v.object({
    maxEnvelopes: v.pipe(
      v.string(),
      v.regex(/^\d+$/, invalidLimit),
      v.transform((value: string) => Number(value)),
      v.check((value: number) => isValidMaxEnvelopes(value), invalidLimit),
      v.check(
        (value) => value >= count,
        `Cannot lower the limit below ${count.toLocaleString()} retained ${count === 1 ? "envelope" : "envelopes"}. Clear envelopes first.`,
      ),
    ),
  });
  const form = useForm<
    v.InferInput<typeof schema>,
    unknown,
    v.InferOutput<typeof schema>
  >({
    resolver: valibotResolver(schema),
    values: { maxEnvelopes: String(limit) },
  });
  const save = form.handleSubmit(async ({ maxEnvelopes }) => {
    form.clearErrors("root");
    const url = new URL(streamUrl);
    url.pathname = /^\/_local\/v1\/sessions\/[^/]+\/stream$/.test(url.pathname)
      ? url.pathname.replace(/\/stream$/, "/ui/retention")
      : "/retention";
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxEnvelopes }),
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
        form.setError("root.server", { message: detail });
        return;
      }
      if (
        typeof body !== "object" ||
        body === null ||
        !("maxEnvelopes" in body) ||
        !isValidMaxEnvelopes(body.maxEnvelopes)
      )
        throw new Error("Invalid retention response");
      // Ordered SSE metadata is authoritative; delayed HTTP responses cannot
      // overwrite a newer CLI change or a different receiver's settings.
    } catch {
      form.setError("root.server", {
        message:
          "Could not update retention. Existing envelopes were preserved.",
      });
    }
  });
  const error =
    form.formState.errors.maxEnvelopes?.message ??
    form.formState.errors.root?.server?.message;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {count.toLocaleString()} {count === 1 ? "envelope" : "envelopes"}{" "}
        currently retained.
      </p>
      {editable ? (
        <form noValidate onSubmit={save} className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="retention-limit" className="text-sm font-medium">
              Retention limit
            </label>
            <Input
              id="retention-limit"
              type="number"
              min={1}
              max={MAX_ENVELOPES}
              step={1}
              aria-invalid={Boolean(error)}
              aria-describedby={`retention-help${error ? " retention-error" : ""}`}
              disabled={form.formState.isSubmitting}
              {...form.register("maxEnvelopes")}
            />
            <p
              id="retention-help"
              className="text-xs leading-relaxed text-muted-foreground"
            >
              Maximum envelopes to keep. To set a limit below the retained
              count, clear events first.
            </p>
            {error ? (
              <p
                id="retention-error"
                role="alert"
                className="text-sm text-destructive"
              >
                {error}
              </p>
            ) : null}
          </div>
          <div className="flex justify-end">
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting
                ? "Applying…"
                : "Apply retention limit"}
            </Button>
          </div>
        </form>
      ) : (
        <div className="space-y-2">
          <dl className="flex items-center justify-between gap-4 text-sm">
            <dt>Retention limit</dt>
            <dd>
              {limit.toLocaleString()} {limit === 1 ? "envelope" : "envelopes"}
            </dd>
          </dl>
          <p className="text-sm text-muted-foreground">
            {unavailableReason ??
              "Change retention from a locally served viewer or the CLI."}
          </p>
        </div>
      )}
    </div>
  );
}
