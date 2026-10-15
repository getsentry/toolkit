import { useCallback, useEffect, useRef, useState } from "react";

/** Test a receiver without replacing the active feed or committing a cancelled attempt. */
export function useReceiverProbe(timeoutMs: number) {
  const [isPending, setIsPending] = useState(false);
  const pending = useRef<{ source: EventSource; timer: number } | undefined>(
    undefined,
  );
  const stop = useCallback((notify = true) => {
    const current = pending.current;
    pending.current = undefined;
    if (current) {
      window.clearTimeout(current.timer);
      current.source.close();
    }
    if (notify) setIsPending(false);
  }, []);
  useEffect(() => () => stop(false), [stop]);
  const probe = (
    url: string,
    onReady: () => void,
    onError: (message: string) => void,
  ) => {
    stop();
    const failure =
      "Could not connect to this receiver. Your current feed is unchanged.";
    let source: EventSource;
    try {
      source = new EventSource(url);
    } catch {
      onError(failure);
      return;
    }
    setIsPending(true);
    const fail = (message: string) => {
      if (pending.current?.source !== source) return;
      stop();
      onError(message);
    };
    const timer = window.setTimeout(
      () =>
        fail(
          "Connection timed out after 10 seconds. Your current feed is unchanged.",
        ),
      timeoutMs,
    );
    pending.current = { source, timer };
    source.onerror = () => fail(failure);
    source.onopen = () => {
      if (pending.current?.source !== source) return;
      // The committed stream replays the receiver buffer with its real metadata.
      stop();
      onReady();
    };
  };
  return { isPending, cancel: stop, probe };
}
