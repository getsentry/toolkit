/** Close pending RPC like Cloudflare's ExecutionGate, and abort upstream HTTP. */
export class ExecutionGate {
  readonly deadline = Date.now() + 30_000;
  readonly #controller = new AbortController();
  readonly signal = this.#controller.signal;
  #resolveClosed!: (reason: Error) => void;
  readonly #whenClosed = new Promise<Error>((resolve) => {
    this.#resolveClosed = resolve;
  });
  readonly #timer = setTimeout(
    () => this.close(new Error("Execution deadline exceeded.")),
    30_000,
  );

  assertOpen(): void {
    if (Date.now() >= this.deadline) {
      this.close(new Error("Execution deadline exceeded."));
    }
    this.signal.throwIfAborted();
  }

  /** Callbacks may outlive this wait; recheck the gate after awaits before HTTP. */
  async run<T>(work: () => Promise<T>): Promise<T> {
    this.assertOpen();
    const result = await Promise.race([
      work(),
      this.#whenClosed.then((reason) => {
        throw reason;
      }),
    ]);
    this.assertOpen();
    return result;
  }

  close(reason = new Error("Code execution has finished.")): void {
    if (this.signal.aborted) return;
    clearTimeout(this.#timer);
    this.#controller.abort(reason);
    this.#resolveClosed(reason);
  }
}
