/**
 * What a link streams, as the streams of a source.
 *
 * @module
 */

import type { Unsubscribe } from '@/core/emitter';
import type { SourceSink } from '@/core/source';

import type { Epoch, EpochEndReason } from './link/epochs';
import type { LinkState, SampleEvent, TimelineEvent } from './link/link-events';
import type { RobotLink } from './link/robot-link';

/** A stream of the sink, and where its variables sit in a sample. */
interface Stream {
  readonly id: number;
  readonly slot: number;
  readonly variableIds: readonly number[];
}

/**
 * Feeds what a link streams into a sink: each epoch as a stream, its samples with how many were
 * dropped before each, and the boundaries nothing may be drawn across.
 *
 * A stream is one epoch, or a chain of them when a group that went out of step is defined again
 * as it was: the epoch that continues another carries on its stream, so the samples lost in
 * between are a gap in it. A stream that ended out of step waits for that while the link
 * configures, and closes once the link settles without it.
 */
export class StreamFeed {
  readonly #sink: SourceSink;
  readonly #streams = new Map<number, Stream>();
  readonly #waiting = new Map<number, Stream>();
  #clock = 0;
  #creditVariable: number | undefined;
  #creditLeft: number | undefined;

  /**
   * @param sink Where the streams go.
   */
  constructor(sink: SourceSink) {
    this.#sink = sink;
  }

  /** The run of the robot's clock the link is on, as the sink numbers clocks. */
  get clock(): number {
    return this.#clock;
  }

  /** The credit the robot last said it had left, once a stream carries it. */
  get creditLeft(): number | undefined {
    return this.#creditLeft;
  }

  /**
   * Read the robot's credit left from the samples of a variable.
   *
   * @param variableId The variable, or undefined to stop.
   */
  watchCredit(variableId: number | undefined): void {
    this.#creditVariable = variableId;
  }

  /**
   * Feed a link into the sink.
   *
   * @returns The functions that stop it.
   */
  listen(link: Pick<RobotLink, 'on'>): Unsubscribe[] {
    return [
      link.on('state', (state) => this.#onState(state)),
      link.on('epoch', (epoch) => this.#onEpoch(epoch)),
      link.on('epochEnd', ({ epoch, reason }) => this.#onEpochEnd(epoch, reason)),
      link.on('sample', (sample) => this.#onSample(sample)),
      link.on('timeline', (timeline) => this.#onTimeline(timeline)),
    ];
  }

  /**
   * A link that lost its transport, or shakes hands again on its own, forgot its streams: mark a
   * `reconnect` boundary. One that settles leaves the streams waiting for a group out of step
   * closed.
   */
  #onState(state: LinkState): void {
    if (
      state.kind === 'disconnected' ||
      (state.kind === 'handshaking' && state.attempt === 1 && state.reason !== 'connected')
    ) {
      this.#streams.clear();
      this.#waiting.clear();
      this.#sink.boundary('reconnect');
    } else if (state.kind !== 'configuring') {
      for (const stream of this.#waiting.values()) {
        this.#sink.streamClosed(stream.id);
      }

      this.#waiting.clear();
    }
  }

  #onEpoch(epoch: Epoch): void {
    const continued =
      epoch.continues === undefined ? undefined : this.#waiting.get(epoch.continues);

    if (epoch.continues !== undefined && continued !== undefined) {
      this.#waiting.delete(epoch.continues);
      this.#streams.set(epoch.id, continued);
      return;
    }

    for (const [epochId, stream] of this.#waiting) {
      if (stream.slot === epoch.group) {
        this.#waiting.delete(epochId);
        this.#sink.streamClosed(stream.id);
      }
    }

    this.#streams.set(epoch.id, {
      id: epoch.id,
      slot: epoch.group,
      variableIds: epoch.variableIds,
    });
    this.#sink.streamOpened({
      id: epoch.id,
      slot: epoch.group,
      variableIds: epoch.variableIds,
      clock: epoch.timeline,
    });
  }

  #onEpochEnd(epoch: Epoch, reason: EpochEndReason): void {
    const stream = this.#streams.get(epoch.id);

    if (stream === undefined) {
      return;
    }

    this.#streams.delete(epoch.id);

    if (reason === 'out-of-step') {
      this.#waiting.set(epoch.id, stream);
    } else {
      this.#sink.streamClosed(stream.id);
    }
  }

  #onSample({ epoch, timeUs, values, missingBefore }: SampleEvent): void {
    const stream = this.#streams.get(epoch);

    if (stream === undefined) {
      return;
    }

    const creditAt =
      this.#creditVariable === undefined ? -1 : stream.variableIds.indexOf(this.#creditVariable);

    if (creditAt >= 0) {
      this.#creditLeft = Number(values[creditAt]);
    }

    this.#sink.sample(stream.id, timeUs, values, missingBefore);
  }

  /**
   * A reboot and a reset of the robot's clock both mark a `reboot` boundary: either way the times
   * before and after belong to different runs of the clock.
   */
  #onTimeline({ id, reason }: TimelineEvent): void {
    this.#clock = id;

    if (reason !== 'connected') {
      this.#sink.boundary('reboot');
      this.#sink.log({
        severity: 'warning',
        source: 'link',
        text: reason === 'reboot' ? 'the robot rebooted' : "the robot's clock reset",
      });
    }
  }
}
