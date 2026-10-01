import { Emitter, type Unsubscribe } from '@/core/emitter';
import type { Value } from '@/core/variables';

import type { BlockBacking, BlockData } from './block-backing';
import { losesPrecision } from './columns';
import type { HistoryStoreOptions } from './history-store';
import { BlockMemory } from './memory/block-memory';
import { RECEIVED_BACKWARDS, StreamRun } from './stream-run';
import { ChangeSignal, TickNotifier } from './tick-notifier';
import type {
  Boundary,
  BoundaryKind,
  HistoryVariable,
  RecordedGap,
  RecordedRun,
  RecordedValue,
  RecordingRecord,
  StoreWarning,
  StreamRunSpec,
} from './types';
import type { VariableHistory } from './variable-history';
import { VariableRegistry } from './variable-registry';

/**
 * Everything that changes the history, behind {@link HistoryStore}: the schema, the runs and
 * their samples, boundaries and values, forgetting it all, and taking a recording back. It owns
 * what the queries read: the variables, the runs, the boundaries and the block memory.
 *
 * What a recording writes besides the blocks, the runs, their gaps once final, the boundaries and
 * the values outside the stored streams, goes to those who {@link follow} it.
 */
export class HistoryIngest {
  /** Tells readers about changes once per tick. */
  readonly notifier: TickNotifier;

  /** Touched when the status, the schema, the runs or the boundaries change. */
  readonly statusSignal: ChangeSignal;

  /** The history of every variable, by name and type, and the current schema. */
  readonly registry: VariableRegistry;

  /** Every run by id, open or closed. */
  readonly runs = new Map<number, StreamRun>();

  /** The blocks and what may stay in memory. */
  readonly memory: BlockMemory;

  /** The warnings, as they happen. */
  readonly warnings = new Emitter<{ warning: StoreWarning }>();

  readonly #blockSize: number;
  readonly #openBySlot = new Map<number, StreamRun>();
  readonly #records = new Emitter<{ record: RecordingRecord }>();
  #followers = 0;
  #boundaries: readonly Boundary[] = [];
  #clockUs = Number.NEGATIVE_INFINITY;
  #resetCount = 0;

  /**
   * @param options Every option of the store, with its default where it was left out.
   */
  constructor(options: Required<HistoryStoreOptions>) {
    this.#blockSize = options.blockSize;
    this.notifier = new TickNotifier(options.scheduler);
    this.statusSignal = new ChangeSignal(this.notifier);
    this.registry = new VariableRegistry(options.historyLength, this.notifier);
    this.memory = new BlockMemory({
      capBytes: options.memoryCapBytes,
      warningRatio: options.warningRatio,
      scheduler: options.scheduler,
      now: options.now,
      flushIntervalMs: options.flushIntervalMs,
      maxConcurrentLoads: options.maxConcurrentLoads,
      runs: this.runs,
      warnings: this.warnings,
      statusSignal: this.statusSignal,
    });
  }

  /** Every boundary so far, oldest first; the same array until a boundary is added. */
  get boundaries(): readonly Boundary[] {
    return this.#boundaries;
  }

  /** How many times the history was forgotten. */
  get resetCount(): number {
    return this.#resetCount;
  }

  /** Take the robot's schema; a name back with another type marks a boundary at `timeUs`. */
  setSchema(entries: readonly HistoryVariable[], timeUs = this.#clockUs): void {
    if (this.registry.setSchema(entries) && Number.isFinite(timeUs)) {
      this.#addBoundary('schema', timeUs);
    }

    this.statusSignal.touch();
  }

  /** Start a run, closing first every open run it conflicts with; returns their ids. */
  openRun(spec: StreamRunSpec): readonly number[] {
    if (this.runs.has(spec.runId)) {
      throw new Error(`Run ${spec.runId} was already opened`);
    }

    if (new Set(spec.variables.map((variable) => variable.id)).size !== spec.variables.length) {
      throw new Error(`Run ${spec.runId} names a variable twice`);
    }

    const variables = spec.variables.map((variable) => ({
      id: variable.id,
      name: variable.name ?? this.registry.nameOf(variable.id),
      type: variable.type,
    }));
    let typeChanged = false;
    const records = variables.map(({ id, name, type }) => {
      const before = this.registry.resolve(name);
      const record = this.registry.recordFor(name, type);
      typeChanged ||= before !== undefined && before !== record;
      record.lastId = id;
      return record;
    });

    if (typeChanged && Number.isFinite(this.#clockUs)) {
      this.#addBoundary('schema', this.#clockUs);
    }

    const closed: number[] = [];

    for (const open of this.runs.values()) {
      const conflicts =
        open.slot === spec.slot || open.records.some((record) => records.includes(record));

      if (!open.closed && conflicts) {
        this.closeRun(open.id);
        closed.push(open.id);
      }
    }

    const run = new StreamRun(
      { runId: spec.runId, slot: spec.slot, variables },
      records,
      this.#blockSize,
      this.memory
    );

    records.forEach((record, index) => {
      record.segments.push({ run, column: run.columnOf[index] });
      record.appended();
    });

    this.runs.set(spec.runId, run);
    this.#openBySlot.set(spec.slot, run);
    this.#emit({ kind: 'run', run: run.recorded });
    this.statusSignal.touch();
    return closed;
  }

  /** Close a run; closing a closed run does nothing. */
  closeRun(runId: number): void {
    const run = this.runs.get(runId);

    if (!run) {
      throw new Error(`No run ${runId}`);
    }

    if (run.closed) {
      return;
    }

    run.close();
    this.#emitFinalGaps(run);

    if (this.#openBySlot.get(run.slot) === run) {
      this.#openBySlot.delete(run.slot);
    }

    for (const record of run.records) {
      record.appended();
    }

    this.#emit({ kind: 'run-closed', runId });
    this.statusSignal.touch();
  }

  /** Add a sample of an open run, after the samples the source lost just before it. */
  append(runId: number, timeUs: number, values: ArrayLike<Value>, missedBefore: number): void {
    const run = this.#openRun(runId);
    const records = run.records;

    if (values.length !== records.length) {
      throw new RangeError(`Run ${runId} takes ${records.length} values, got ${values.length}`);
    }

    const received = run.receive(timeUs, missedBefore);

    if (received === RECEIVED_BACKWARDS) {
      this.warnings.emit('warning', {
        type: 'time-backwards',
        runId,
        timeUs,
        lastUs: run.lastTimeUs,
      });
    }

    const kept = received >= 0;
    const stored = kept && run.store(timeUs, values);

    if (stored) {
      this.#emitFinalGaps(run);
    }

    if (kept) {
      this.#clockUs = Math.max(this.#clockUs, timeUs);
    }

    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      const value = values[index];
      const numeric = run.columnOf[index] >= 0;
      record.setLatest(value, timeUs);

      if (!numeric) {
        record.remember(value, timeUs);
        this.#emitValue(record, run.variables[index].id, value, timeUs);
      } else if (kept) {
        this.#checkPrecision(record, run.wide[index], value);
      }

      if (numeric && stored) {
        record.tailUs = timeUs;
        record.appended();
      } else {
        record.changed();
      }
    }

    this.memory.writer.flushIfDue();
  }

  /** Mark a moment no line is drawn across, closing every open run. */
  markBoundary(kind: BoundaryKind, timeUs: number): void {
    this.#addBoundary(kind, timeUs);

    for (const run of this.#openBySlot.values()) {
      this.closeRun(run.id);
    }
  }

  /** Record a value that did not come in a stream sample. */
  setLatestValue(variableId: number, value: Value, timeUs?: number): void {
    const record = this.registry.recordFor(
      this.registry.nameOf(variableId),
      this.registry.typeOf(variableId)
    );
    record.lastId = variableId;
    record.setLatest(value, timeUs);

    if (!record.numeric) {
      record.remember(value, timeUs);
    }

    record.changed();
    this.#emitValue(record, variableId, value, timeUs ?? Number.NaN);
  }

  /** Forget the history and stop recording, keeping the schema, latest values and open runs. */
  reset(): void {
    for (const run of this.runs.values()) {
      if (!run.closed) {
        run.clearHistory();
      }
    }

    this.memory.reset();

    for (const [runId, run] of this.runs) {
      if (run.closed) {
        this.runs.delete(runId);
      }
    }

    for (const record of this.registry.all()) {
      const open = record.segments.filter((segment) => !segment.run.closed);
      record.segments.length = 0;
      record.segments.push(...open);
      record.tailUs = Number.NEGATIVE_INFINITY;
      record.rewritten();
    }

    this.#boundaries = [];
    this.#resetCount++;
    this.statusSignal.touch();
  }

  /** Take back a closed run of a recording; returns how many of its blocks did not fit. */
  restoreRun(
    recorded: RecordedRun,
    blocks: Iterable<BlockData>,
    gaps: readonly RecordedGap[],
    source: BlockBacking
  ): number {
    if (this.runs.has(recorded.runId)) {
      throw new Error(`Run ${recorded.runId} appears twice in the session`);
    }

    const records = recorded.variables.map(({ id, name, type }) => {
      const record = this.registry.recordFor(name, type);
      record.lastId = id;
      return record;
    });
    const run = new StreamRun(recorded, records, this.#blockSize, this.memory);
    records.forEach((record, index) => {
      record.segments.push({ run, column: run.columnOf[index] });
    });
    this.runs.set(recorded.runId, run);
    let skipped = 0;
    let last: BlockData | undefined;

    for (const data of blocks) {
      const block = run.restoreBlock(data);

      if (!block) {
        skipped++;
        continue;
      }

      this.memory.adopt(block, source);
      last = data.time.length > 0 ? data : last;
    }

    run.finishRestore(gaps);

    if (last) {
      this.#takeLastSamples(run, last);
    }

    for (const record of records) {
      record.rewritten();
    }

    return skipped;
  }

  /** Take back a value of a recording; a variable with stored samples keeps the last one. */
  restoreValue({ variableId, name, timeUs, value }: RecordedValue): void {
    const record = this.registry.recordFor(name, this.registry.typeOf(variableId));
    const time = Number.isNaN(timeUs) ? undefined : timeUs;
    record.lastId = variableId;

    if (record.tailUs === Number.NEGATIVE_INFINITY) {
      record.setLatest(value, time);
    }

    if (!record.numeric) {
      record.remember(value, time);
    }

    record.changed();
  }

  /**
   * Tell a listener what a recording of the session so far holds besides the blocks, then each
   * such record as it becomes final, until it stops.
   */
  follow(listener: (record: RecordingRecord) => void): Unsubscribe {
    for (const record of this.#recordedSoFar()) {
      listener(record);
    }

    const stop = this.#records.on('record', listener);
    let following = true;
    this.#followers++;
    return () => {
      if (following) {
        following = false;
        this.#followers--;
        stop();
      }
    };
  }

  *#recordedSoFar(): Generator<RecordingRecord> {
    for (const run of this.runs.values()) {
      yield { kind: 'run', run: run.recorded };

      for (const gap of run.gaps) {
        if (run.closed || !Number.isNaN(gap.untilUs)) {
          yield { kind: 'gap', gap: run.recordedGap(gap) };
        }
      }

      if (run.closed) {
        yield { kind: 'run-closed', runId: run.id };
      }
    }

    for (const boundary of this.#boundaries) {
      yield { kind: 'boundary', boundary };
    }

    for (const record of this.registry.all()) {
      const latest = record.latest;

      if (latest && !record.numeric && record.lastId !== undefined) {
        yield {
          kind: 'value',
          value: {
            variableId: record.lastId,
            name: record.name,
            timeUs: latest.timeUs ?? Number.NaN,
            value: latest.value,
          },
        };
      }
    }
  }

  #openRun(runId: number): StreamRun {
    const run = this.runs.get(runId);

    if (!run) {
      throw new Error(`No run ${runId}`);
    }

    if (run.closed) {
      throw new Error(`Run ${runId} is closed`);
    }

    return run;
  }

  #takeLastSamples(run: StreamRun, last: BlockData): void {
    const at = last.time.length - 1;
    const timeUs = last.time[at];

    run.records.forEach((record, index) => {
      const column = run.columnOf[index];

      if (column >= 0 && record.tailUs <= timeUs) {
        record.setLatest(last.columns[column].values[at], timeUs);
        record.tailUs = timeUs;
        this.#clockUs = Math.max(this.#clockUs, timeUs);
      }
    });
  }

  #checkPrecision(record: VariableHistory, wide: boolean, value: Value): void {
    if (wide && !record.precisionLost && losesPrecision(value)) {
      record.precisionLost = true;
      this.warnings.emit('warning', { type: 'precision-loss', name: record.name });
    }
  }

  #addBoundary(kind: BoundaryKind, timeUs: number): void {
    const boundary = { kind, timeUs };
    this.#boundaries = [...this.#boundaries, boundary];

    for (const record of this.registry.all()) {
      if (timeUs < record.tailUs) {
        record.rewritten();
      } else {
        record.appended();
      }
    }

    this.#emit({ kind: 'boundary', boundary });
    this.statusSignal.touch();
  }

  #emitFinalGaps(run: StreamRun): void {
    for (const gap of run.takeFinalGaps()) {
      this.#emit({ kind: 'gap', gap: run.recordedGap(gap) });
    }
  }

  #emitValue(record: VariableHistory, variableId: number, value: Value, timeUs: number): void {
    if (this.#followers > 0) {
      this.#emit({ kind: 'value', value: { variableId, name: record.name, timeUs, value } });
    }
  }

  #emit(record: RecordingRecord): void {
    this.#records.emit('record', record);
  }
}
