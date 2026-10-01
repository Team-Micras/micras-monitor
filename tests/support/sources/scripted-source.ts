/**
 * Sources for tests: one the test drives by hand through the sink the monitor gave it, and a
 * wrapper that changes what another source answers, loses or measures.
 *
 * @module
 */

import type {
  CommandOutcome,
  ReadOutcome,
  Source,
  SourceConnection,
  SourceSink,
  SourceStats,
  StreamDemand,
  Target,
  TargetKind,
  WriteOutcome,
  WriteValue,
} from '@/core/source';

/** A connection of a {@link ScriptedSource}: what the monitor asked of it, and its sink. */
export class ScriptedConnection implements SourceConnection {
  readonly target: Target;
  readonly sink: SourceSink;
  readonly demands: (readonly StreamDemand[])[] = [];
  readonly commands: (readonly [code: number, argument: number])[] = [];
  readonly writes: (readonly [variableId: number, value: WriteValue])[] = [];
  readonly pending = new Map<number, WriteValue>();
  closed = false;
  #source: ScriptedSource;

  constructor(source: ScriptedSource, target: Target, sink: SourceSink) {
    this.#source = source;
    this.target = target;
    this.sink = sink;
  }

  request(demands: readonly StreamDemand[]): void {
    this.demands.push(demands);
  }

  command(code: number, argument = 0): Promise<CommandOutcome> {
    this.commands.push([code, argument]);
    return Promise.resolve(this.#source.answer(code, argument));
  }

  write(variableId: number, value: WriteValue): Promise<WriteOutcome> {
    this.writes.push([variableId, value]);
    return Promise.resolve({ status: 'confirmed' });
  }

  read(variableId: number): Promise<ReadOutcome> {
    return Promise.resolve({ status: 'failed', message: `no answer for ${variableId}` });
  }

  pendingWrite(variableId: number): WriteValue | undefined {
    return this.pending.get(variableId);
  }

  close(): void {
    this.closed = true;
  }
}

/** A source that does nothing by itself: the test pushes into the sink of each connection. */
export class ScriptedSource implements Source {
  readonly id = 'scripted';
  readonly targets: readonly TargetKind[] = ['websocket', 'bluetooth'];
  readonly connections: ScriptedConnection[] = [];
  /** How every command is answered; accepted by default. */
  answer: (code: number, argument: number) => CommandOutcome = () => ({
    status: 'ok',
    reason: 0,
  });

  /** The latest connection. */
  get last(): ScriptedConnection {
    const connection = this.connections.at(-1);

    if (connection === undefined) {
      throw new Error('nothing connected to the scripted source yet');
    }

    return connection;
  }

  connect(target: Target, sink: SourceSink): SourceConnection {
    const connection = new ScriptedConnection(this, target, sink);
    this.connections.push(connection);
    return connection;
  }
}

/** What {@link scripted} changes of a source. */
export interface Script {
  /** Answers a command instead of the source, which `inner` still reaches. */
  readonly command?: (
    code: number,
    argument: number,
    inner: SourceConnection
  ) => Promise<CommandOutcome>;
  /** Answers a read instead of the source, which `inner` still reaches. */
  readonly read?: (variableId: number, inner: SourceConnection) => Promise<ReadOutcome>;
  /** Loses the samples of a stream, numbered from 0, that it returns true for. */
  readonly drops?: (index: number) => boolean;
  /** Changes the counters the source reports. */
  readonly stats?: (stats: SourceStats) => SourceStats;
}

/** A source that is `inner` with the changes of `script`. */
export function scripted(inner: Source, script: Script): Source {
  return {
    id: inner.id,
    targets: inner.targets,
    connect: (target, sink) => {
      const counts = new Map<number, { index: number; lost: number }>();
      const connection = inner.connect(target, {
        ...sink,
        sample: (stream, timeUs, values, missedBefore) => {
          const count = counts.get(stream) ?? { index: 0, lost: 0 };
          counts.set(stream, count);

          if (script.drops?.(count.index++) === true) {
            count.lost++;
            return;
          }

          sink.sample(stream, timeUs, values, missedBefore + count.lost);
          count.lost = 0;
        },
        stats: (stats) => sink.stats(script.stats?.(stats) ?? stats),
      });

      return {
        request: (demands) => connection.request(demands),
        command: (code, argument = 0) =>
          script.command?.(code, argument, connection) ?? connection.command(code, argument),
        write: (variableId, value) => connection.write(variableId, value),
        read: (variableId) => script.read?.(variableId, connection) ?? connection.read(variableId),
        pendingWrite: (variableId) => connection.pendingWrite(variableId),
        close: () => connection.close(),
      };
    },
  };
}
