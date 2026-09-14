/** Per-attempt abort controller linking the caller's signal and an optional timeout. */
export class AttemptController {
  readonly #controller = new AbortController();
  readonly #parent: AbortSignal | undefined;
  readonly #onParentAbort = (): void => {
    this.#controller.abort();
  };
  #timer: ReturnType<typeof setTimeout> | undefined;
  #timedOut = false;

  constructor(parent: AbortSignal | undefined, timeoutMs: number) {
    this.#parent = parent;
    if (parent) {
      if (parent.aborted) this.#controller.abort();
      else parent.addEventListener("abort", this.#onParentAbort, { once: true });
    }
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      this.#timer = setTimeout(() => {
        this.#timedOut = true;
        this.#controller.abort();
      }, timeoutMs);
    }
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get timedOut(): boolean {
    return this.#timedOut;
  }

  get abortedByCaller(): boolean {
    return this.#parent?.aborted === true;
  }

  abort(): void {
    this.#controller.abort();
  }

  /** Stops the timeout without detaching the caller's signal (used once a stream is established). */
  clearTimer(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  dispose(): void {
    this.clearTimer();
    this.#parent?.removeEventListener("abort", this.#onParentAbort);
  }
}
