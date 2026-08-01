export interface Disposable {
  dispose(): void;
}

export class DisposalBag implements Disposable {
  private readonly resources: Disposable[] = [];
  private disposed = false;

  add<T extends Disposable>(resource: T): T {
    if (this.disposed) {
      throw new Error("DisposalBag: cannot register a resource on a bag that was already disposed");
    }
    this.resources.push(resource);
    return resource;
  }

  addFn(fn: () => void): void {
    this.add({ dispose: fn });
  }

  get size(): number {
    return this.resources.length;
  }

  /**
   * Releases in reverse registration order so a resource is never torn down
   * before something that still holds a handle to it. A resource that throws
   * cannot be allowed to strand the rest of the bag, which on a GPU teardown
   * would mean leaking every texture and buffer registered before it, so
   * failures are collected and rethrown once everything has been released.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    const failures: unknown[] = [];
    for (let i = this.resources.length - 1; i >= 0; i -= 1) {
      try {
        this.resources[i]?.dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    this.resources.length = 0;

    if (failures.length > 0) {
      throw new AggregateError(failures, `DisposalBag: ${failures.length} resource(s) failed to dispose`);
    }
  }
}
