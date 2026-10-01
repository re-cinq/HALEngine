const settled = (): void => undefined;

/** Runs one callback per key at a time, in call order; callbacks on different keys never wait on each other. */
export class PerSessionLock {
  // Keys and the promise each queue settles on: nothing a callback handles, and only while a callback is queued.
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(fn);
    const tail = result.then(settled, settled);
    this.tails.set(key, tail);
    void tail.then(() => this.forget(key, tail));
    return result;
  }

  /** How many keys have a callback queued or running: zero once every one has settled. */
  get size(): number {
    return this.tails.size;
  }

  // Only the newest tail clears its key: a callback queued behind it keeps the key until it settles too.
  private forget(key: string, tail: Promise<void>): void {
    if (this.tails.get(key) === tail) this.tails.delete(key);
  }
}
