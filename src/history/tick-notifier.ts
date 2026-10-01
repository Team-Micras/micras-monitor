import type { Scheduler } from './scheduler';

interface Subscription {
  readonly callback: () => void;
  active: boolean;
}

/**
 * Something readers can subscribe to, with a version that grows on every change.
 */
export class ChangeSignal {
  /** Grows by one on every change. */
  version = 0;

  /** Whether a change is waiting for the next tick. */
  dirty = false;

  /** Who hears about changes. */
  readonly subscriptions = new Set<Subscription>();
}

/**
 * Tells subscribers about changes at most once per scheduler tick, however many changes happened
 * and however many of their channels they touched. A subscriber that throws does not keep the
 * others from hearing; its error is thrown again once all were called. A subscription ended
 * during a tick is not called in it.
 */
export class TickNotifier {
  private dirty: ChangeSignal[] = [];
  private scheduled = false;

  /**
   * @param scheduler Decides when a tick happens.
   */
  constructor(private readonly scheduler: Scheduler) {}

  /**
   * Record a change of a channel; its subscribers hear about it on the next tick.
   */
  touch(channel: ChangeSignal): void {
    channel.version++;

    if (channel.dirty) {
      return;
    }

    channel.dirty = true;
    this.dirty.push(channel);

    if (!this.scheduled) {
      this.scheduled = true;
      this.scheduler.schedule(() => this.flush());
    }
  }

  /**
   * Call back once per tick in which any of the channels changed.
   *
   * @param channels What to watch.
   * @param callback What to call.
   * @returns A function that ends the subscription.
   */
  subscribe(channels: readonly ChangeSignal[], callback: () => void): () => void {
    const subscription: Subscription = { callback, active: true };

    for (const channel of channels) {
      channel.subscriptions.add(subscription);
    }

    return () => {
      subscription.active = false;

      for (const channel of channels) {
        channel.subscriptions.delete(subscription);
      }
    };
  }

  private flush(): void {
    const channels = this.dirty;
    this.dirty = [];
    this.scheduled = false;
    const due = new Set<Subscription>();

    for (const channel of channels) {
      channel.dirty = false;

      for (const subscription of channel.subscriptions) {
        due.add(subscription);
      }
    }

    const errors: unknown[] = [];

    for (const subscription of due) {
      if (!subscription.active) {
        continue;
      }

      try {
        subscription.callback();
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length === 1) {
      throw errors[0];
    }

    if (errors.length > 1) {
      throw new AggregateError(errors, 'Several subscribers failed');
    }
  }
}
