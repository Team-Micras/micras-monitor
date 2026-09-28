import {
  MAX_GROUP_VARIABLES,
  MAX_GROUPS,
  MAX_PAYLOAD_SIZE,
  readValue,
  TYPE_SIZE,
  TypeCode,
} from '../protocol';
import type { SchemaEntry } from './schema';

/** The group, sequence number and timestamp in front of the values of a sample. */
export const SAMPLE_HEADER_SIZE = 7;

/** A set of variables to stream together, sampled in the same loop iteration. */
export interface GroupRequest {
  /** The variables, in the order their values are packed. */
  readonly variableIds: readonly number[];

  /** How many loop iterations between two samples. */
  readonly periodTicks: number;
}

/** A group request checked against the schema, ready to be sent. */
export interface GroupLayout extends GroupRequest {
  /** The slot on the robot, which is the position of the request. */
  readonly group: number;

  /** The type of each variable. */
  readonly types: readonly TypeCode[];

  /** The bytes of the values of one sample. */
  readonly sampleSize: number;
}

/**
 * One definition of a group, from its GROUP_ACK until the group is defined again or the session
 * restarts. The robot restarts the sequence of a group every time it is defined, so a sequence
 * number only means something inside its epoch.
 */
export interface Epoch {
  /** Unique for the life of the session, never reused. */
  readonly id: number;
  readonly group: number;
  readonly variableIds: readonly number[];
  /** The period the robot acknowledged. */
  readonly periodTicks: number;
  /** The sample size the robot acknowledged. */
  readonly sampleSize: number;
}

/** A decoded value: booleans as 0 or 1, 64 bit integers as `bigint`. */
export type SampleValue = number | bigint;

/**
 * Check a set of group requests against the schema and the robot's limits.
 *
 * @param schema The robot's schema.
 * @param requests One request per group, at most `MAX_GROUPS`.
 * @returns The layouts to send.
 * @throws If a request cannot be streamed as asked.
 */
export function planGroups(
  schema: readonly SchemaEntry[],
  requests: readonly GroupRequest[]
): GroupLayout[] {
  if (requests.length > MAX_GROUPS) {
    throw new Error(`The robot holds ${MAX_GROUPS} groups, ${requests.length} were asked for`);
  }

  return requests.map((request, group) => planGroup(schema, request, group));
}

function planGroup(
  schema: readonly SchemaEntry[],
  request: GroupRequest,
  group: number
): GroupLayout {
  const { variableIds, periodTicks } = request;

  if (variableIds.length === 0 || variableIds.length > MAX_GROUP_VARIABLES) {
    throw new Error(`Group ${group} must have 1 to ${MAX_GROUP_VARIABLES} variables`);
  }

  if (!Number.isInteger(periodTicks) || periodTicks < 1 || periodTicks > 0xffff) {
    throw new Error(`Group ${group} period must be 1 to 65535 ticks, got ${periodTicks}`);
  }

  const types = variableIds.map((id) => streamableType(schema, id));
  const sampleSize = types.reduce((total, type) => total + TYPE_SIZE[type], 0);

  if (sampleSize + SAMPLE_HEADER_SIZE > MAX_PAYLOAD_SIZE) {
    throw new Error(`Group ${group} samples would take ${sampleSize} bytes, too many for a frame`);
  }

  return { group, variableIds: [...variableIds], periodTicks, types, sampleSize };
}

function streamableType(schema: readonly SchemaEntry[], id: number): TypeCode {
  const entry = schema[id] as SchemaEntry | undefined;

  if (!entry) {
    throw new Error(`No variable ${id} in the schema`);
  }

  if (!entry.access.stream || entry.type === TypeCode.BLOB) {
    throw new Error(`${entry.name} cannot be streamed`);
  }

  return entry.type;
}

/**
 * Whether a layout is what an open epoch already streams.
 */
export function sameLayout(layout: GroupLayout, epoch: Epoch): boolean {
  return (
    layout.group === epoch.group &&
    layout.periodTicks === epoch.periodTicks &&
    layout.variableIds.length === epoch.variableIds.length &&
    layout.variableIds.every((id, index) => epoch.variableIds[index] === id)
  );
}

/**
 * An epoch that samples are arriving for: it decodes them and counts the ones the robot dropped.
 */
export class OpenEpoch {
  private expectedSeq = 0;

  constructor(
    readonly epoch: Epoch,
    private readonly types: readonly TypeCode[]
  ) {}

  /**
   * Account for the sequence number of a sample.
   *
   * @param seq The u16 sequence number the sample carries.
   * @returns How many samples went missing just before it.
   */
  advance(seq: number): number {
    const missing = (seq - this.expectedSeq) & 0xffff;
    this.expectedSeq = (seq + 1) & 0xffff;
    return missing;
  }

  /**
   * Read the values of a sample.
   *
   * @param bytes The bytes after the sample header.
   * @returns One value per variable, or null when the size is not the acknowledged one.
   */
  decode(bytes: Uint8Array): SampleValue[] | null {
    if (bytes.length !== this.epoch.sampleSize) {
      return null;
    }

    const values: SampleValue[] = [];
    let offset = 0;

    for (const type of this.types) {
      values.push(asSampleValue(readValue(bytes, offset, type)));
      offset += TYPE_SIZE[type];
    }

    return values;
  }
}

function asSampleValue(value: ReturnType<typeof readValue>): SampleValue {
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }

  return typeof value === 'number' || typeof value === 'bigint' ? value : Number.NaN;
}

/**
 * The epoch each group is in, and where every new one gets its id.
 */
export class EpochRegistry {
  private readonly open = new Map<number, OpenEpoch>();
  private lastId = 0;

  /**
   * Start a new epoch for a group, ending the one it was in.
   *
   * @param layout What was defined.
   * @param periodTicks The period the robot acknowledged.
   * @param sampleSize The sample size the robot acknowledged.
   */
  begin(layout: GroupLayout, periodTicks: number, sampleSize: number): OpenEpoch {
    const epoch: Epoch = {
      id: ++this.lastId,
      group: layout.group,
      variableIds: layout.variableIds,
      periodTicks,
      sampleSize,
    };
    const open = new OpenEpoch(epoch, layout.types);

    this.open.set(layout.group, open);
    return open;
  }

  /** The epoch a group is in, if any. */
  current(group: number): OpenEpoch | undefined {
    return this.open.get(group);
  }

  /** End the epoch of a group. */
  end(group: number): void {
    this.open.delete(group);
  }

  /** End every epoch, because the robot forgot its groups. */
  endAll(): void {
    this.open.clear();
  }

  /** Every open epoch. */
  all(): Epoch[] {
    return [...this.open.values()].map((open) => open.epoch);
  }
}
