import type { Unsubscribe } from "./NetworkAdapter";

/** Minimal synchronous fan-out used by every adapter's subscription methods. */
export class Signal<T> {
  private readonly listeners = new Set<(value: T) => void>();

  subscribe(listener: (value: T) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(value: T): void {
    // Copied so a listener that unsubscribes during dispatch cannot skip a peer.
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
