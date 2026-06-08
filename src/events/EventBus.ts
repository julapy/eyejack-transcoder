/**
 * EventBus — a small typed event emitter. The Transcoder emits a typed stream of
 * progress/log/lifecycle events through this so consumers (a host UI, the
 * standalone harness, e2e tests) subscribe once rather than wiring per-call callbacks.
 */

type EventHandler<T> = T extends void ? () => void : (payload: T) => void;
type WildcardHandler = (event: string, payload: unknown) => void;

export class EventBus<TEvents extends { [K in keyof TEvents]: unknown }> {
  private listeners = new Map<keyof TEvents, Set<EventHandler<unknown>>>();
  private wildcardListeners = new Set<WildcardHandler>();

  on<K extends keyof TEvents>(event: K, handler: EventHandler<TEvents[K]>): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler as EventHandler<unknown>);
  }

  once<K extends keyof TEvents>(event: K, handler: EventHandler<TEvents[K]>): void {
    const wrapped = ((...args: unknown[]) => {
      this.off(event, wrapped as EventHandler<TEvents[K]>);
      (handler as (...a: unknown[]) => void)(...args);
    }) as EventHandler<TEvents[K]>;
    this.on(event, wrapped);
  }

  off<K extends keyof TEvents>(event: K, handler: EventHandler<TEvents[K]>): void {
    this.listeners.get(event)?.delete(handler as EventHandler<unknown>);
  }

  emit<K extends keyof TEvents>(
    event: K,
    ...args: TEvents[K] extends void ? [] : [TEvents[K]]
  ): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      for (const handler of handlers) {
        (handler as (...a: unknown[]) => void)(args[0]);
      }
    }
    for (const handler of this.wildcardListeners) {
      handler(event as string, args[0]);
    }
  }

  onAny(handler: WildcardHandler): void {
    this.wildcardListeners.add(handler);
  }

  offAny(handler: WildcardHandler): void {
    this.wildcardListeners.delete(handler);
  }

  dispose(): void {
    this.listeners.clear();
    this.wildcardListeners.clear();
  }
}
