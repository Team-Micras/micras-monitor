/** A function called with the payload of one event. */
export type Listener<T> = (payload: T) => void;

/** Stops a listener from being called again. */
export type Unsubscribe = () => void;

/**
 * A small typed event emitter, with no DOM and no framework behind it.
 *
 * A listener that throws does not stop the others from being called, and does not unwind into
 * the code that emitted: its error is rethrown on its own task, where it is reported like any
 * other uncaught error.
 *
 * @typeParam Events Maps each event name to the type of its payload.
 */
export class Emitter<Events extends object> {
  private readonly listeners: { [K in keyof Events]?: Set<Listener<Events[K]>> } = {};

  /**
   * Call a listener every time an event is emitted.
   *
   * @param event The event to listen to.
   * @param listener What to call with its payload.
   * @returns A function that removes the listener.
   */
  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): Unsubscribe {
    const set = this.listeners[event] ?? new Set();
    set.add(listener);
    this.listeners[event] = set;

    return () => {
      set.delete(listener);
    };
  }

  /**
   * Call every listener of an event.
   *
   * @param event The event to emit.
   * @param payload What the listeners are called with.
   */
  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    for (const listener of this.listeners[event] ?? []) {
      callIsolated(listener, payload);
    }
  }
}

function callIsolated<T>(listener: Listener<T>, payload: T): void {
  try {
    listener(payload);
  } catch (error) {
    queueMicrotask(() => {
      throw error;
    });
  }
}
