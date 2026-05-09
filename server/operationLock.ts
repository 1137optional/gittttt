// Serializes Git operations on a single repository.
// All mutating Git calls go through `run()`; reads are bypassed by default
// because they are safe to run while another op is in flight.
//
// If an operation throws, the lock is still released and the queue keeps draining.
export class OperationLock {
  private current: string | null = null;
  private queue: Array<() => void> = [];

  isBusy(): boolean {
    return this.current !== null;
  }

  currentName(): string | null {
    return this.current;
  }

  async run<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (this.current !== null) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.current = name;
    try {
      return await fn();
    } finally {
      this.current = null;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}
