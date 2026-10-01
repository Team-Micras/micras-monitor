import type { ValueType } from '@/core/variables';

import { Channel } from './notifier';
import type { HistoryVariable, VariableRef } from './types';
import { VariableRecord } from './variable';

/**
 * The records of every variable, keyed by name and type, and the current schema that maps the
 * robot's ids to names.
 *
 * Ids change from one firmware to the next; names are what a history and a layout mean, so a
 * query by name finds the same history across a schema change. Without a schema, a variable is
 * named after its id.
 */
export class ChannelRegistry {
  private readonly records = new Map<string, VariableRecord>();
  private readonly latestByName = new Map<string, VariableRecord>();
  private readonly channels = new Map<string, Channel>();
  private schema = new Map<number, HistoryVariable>();

  /**
   * @param historyLength How many values to keep for variables not stored numerically.
   */
  constructor(private readonly historyLength: number) {}

  /** Every record, one per name and type. */
  all(): IterableIterator<VariableRecord> {
    return this.records.values();
  }

  /**
   * Take a new schema.
   *
   * @returns Whether a name already known came back with another type.
   */
  setSchema(entries: readonly HistoryVariable[]): boolean {
    this.schema = new Map(entries.map((entry) => [entry.id, entry]));
    let changed = false;

    for (const entry of entries) {
      const current = this.latestByName.get(entry.name);

      if (current?.type !== undefined && current.type !== entry.type) {
        changed = true;
      }

      this.recordFor(entry.name, entry.type);
    }

    return changed;
  }

  /** The name of an id in the current schema, or one made from the id. */
  nameOf(id: number): string {
    return this.schema.get(id)?.name ?? `#${id}`;
  }

  /** The type of an id in the current schema, if it has one. */
  typeOf(id: number): ValueType | undefined {
    return this.schema.get(id)?.type;
  }

  /**
   * The record of a name and type, made if needed. A record whose type was not known yet takes
   * the type; a different known type goes back to the record of that type, or starts one.
   */
  recordFor(name: string, type: ValueType | undefined): VariableRecord {
    const current = this.latestByName.get(name);

    if (current && (type === undefined || current.type === type)) {
      return current;
    }

    if (current && current.type === undefined) {
      this.records.delete(keyOf(name, undefined));
      this.records.set(keyOf(name, type), current);
      current.type = type;
      return current;
    }

    let record = this.records.get(keyOf(name, type));

    if (!record) {
      record = new VariableRecord(name, type, this.channelOf(name), this.historyLength);
      this.records.set(keyOf(name, type), record);
    }

    this.latestByName.set(name, record);
    return record;
  }

  /**
   * The record a reference points at, if there is one: the current one of a name or id, or the
   * one of a name and type.
   */
  resolve(ref: VariableRef): VariableRecord | undefined {
    if (typeof ref === 'object') {
      return this.records.get(keyOf(ref.name, ref.type));
    }

    return this.latestByName.get(typeof ref === 'number' ? this.nameOf(ref) : ref);
  }

  /** The change channel of the name a reference points at, made if needed. */
  channelFor(ref: VariableRef): Channel {
    if (typeof ref === 'object') {
      return this.channelOf(ref.name);
    }

    return this.channelOf(typeof ref === 'number' ? this.nameOf(ref) : ref);
  }

  private channelOf(name: string): Channel {
    let channel = this.channels.get(name);

    if (!channel) {
      channel = new Channel();
      this.channels.set(name, channel);
    }

    return channel;
  }
}

function keyOf(name: string, type: ValueType | undefined): string {
  return `${name}\u0000${type ?? ''}`;
}
