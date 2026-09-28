/**
 * The variables of the simulated robot: a subset of the Micras firmware's, with made-up signals.
 *
 * @module
 */

import { CREDIT_WINDOW, TypeCode } from '../../src/protocol';

/** One registered variable, the way the firmware's pool holds it. */
export interface Variable {
  name: string;
  type: TypeCode;
  access: number;
  value: number | boolean;
  sample?: (t: number) => number;
  /** How a blob's bytes are to be read, which only a blob has. */
  typeTag?: string;
  /** What a blob serializes to when read. */
  serialize?: () => Uint8Array;
}

/** The access bits of a schema entry, as `Access::to_byte` packs them. */
export const ACCESS_STREAM = 0x01;
export const ACCESS_WRITE = 0x02;
export const ACCESS_IDLE = 0x04;
const ACCESS_PERSIST = 0x08;

/**
 * A fresh set of the robot's variables, as a robot that just booted holds them.
 */
export function createVariables(): Variable[] {
  return [
    { name: 'state', type: TypeCode.U8, access: ACCESS_STREAM, value: 0 },
    {
      name: 'maze',
      type: TypeCode.BLOB,
      access: ACCESS_PERSIST,
      value: 0,
      typeTag: 'maze-grid',
      serialize: () => new Uint8Array(32).map((_, index) => (index * 37) & 0xff),
    },
    {
      name: 'imu/gyro_x',
      type: TypeCode.F32,
      access: ACCESS_STREAM,
      value: 0,
      sample: (t) => Math.sin(t * 3),
    },
    {
      name: 'imu/gyro_y',
      type: TypeCode.F32,
      access: ACCESS_STREAM,
      value: 0,
      sample: (t) => Math.cos(t * 3),
    },
    {
      name: 'imu/gyro_z',
      type: TypeCode.F32,
      access: ACCESS_STREAM,
      value: 0,
      sample: (t) => Math.sin(t * 11) * 0.3,
    },
    {
      name: 'imu/accel_x',
      type: TypeCode.F32,
      access: ACCESS_STREAM,
      value: 0,
      sample: (t) => Math.sin(t) * 2,
    },
    {
      name: 'imu/accel_y',
      type: TypeCode.F32,
      access: ACCESS_STREAM,
      value: 0,
      sample: (t) => Math.cos(t) * 2,
    },
    {
      name: 'imu/accel_z',
      type: TypeCode.F32,
      access: ACCESS_STREAM,
      value: 0,
      sample: () => 9.81,
    },
    {
      name: 'wall/0',
      type: TypeCode.F32,
      access: ACCESS_STREAM,
      value: 0,
      sample: (t) => 0.5 + Math.sin(t * 0.7) * 0.4,
    },
    {
      name: 'wall/1',
      type: TypeCode.F32,
      access: ACCESS_STREAM,
      value: 0,
      sample: (t) => 0.5 + Math.cos(t * 0.7) * 0.4,
    },
    {
      name: 'wall/2',
      type: TypeCode.F32,
      access: ACCESS_STREAM,
      value: 0,
      sample: (t) => 0.5 + Math.sin(t * 1.3) * 0.3,
    },
    {
      name: 'wall/3',
      type: TypeCode.F32,
      access: ACCESS_STREAM,
      value: 0,
      sample: (t) => 0.5 + Math.cos(t * 1.3) * 0.3,
    },
    {
      name: 'loop/elapsed_time',
      type: TypeCode.F32,
      access: ACCESS_STREAM,
      value: 0,
      sample: () => 0.000125,
    },
    {
      name: 'loop/worst_time_us',
      type: TypeCode.U32,
      access: ACCESS_STREAM,
      value: 0,
      sample: () => 91,
    },
    {
      name: 'cmd/linear',
      type: TypeCode.F32,
      access: ACCESS_STREAM,
      value: 0,
      sample: (t) => Math.min(t % 4, 1.5),
    },
    {
      name: 'cmd/angular',
      type: TypeCode.F32,
      access: ACCESS_STREAM,
      value: 0,
      sample: (t) => Math.sin(t * 2) * 4,
    },
    {
      name: 'response/left',
      type: TypeCode.F32,
      access: ACCESS_STREAM,
      value: 0,
      sample: (t) => Math.sin(t * 2 + 0.1) * 30,
    },
    {
      name: 'response/right',
      type: TypeCode.F32,
      access: ACCESS_STREAM,
      value: 0,
      sample: (t) => Math.sin(t * 2 - 0.1) * 30,
    },
    {
      name: 'feed_forward/left',
      type: TypeCode.F32,
      access: ACCESS_STREAM,
      value: 0,
      sample: (t) => Math.min(t % 4, 1.5) * 20,
    },
    {
      name: 'feed_forward/right',
      type: TypeCode.F32,
      access: ACCESS_STREAM,
      value: 0,
      sample: (t) => Math.min(t % 4, 1.5) * 20,
    },
    {
      name: 'objective',
      type: TypeCode.U8,
      access: ACCESS_STREAM | ACCESS_WRITE | ACCESS_IDLE,
      value: 0,
    },
    {
      name: 'run_profile',
      type: TypeCode.U8,
      access: ACCESS_STREAM | ACCESS_WRITE | ACCESS_PERSIST,
      value: 0,
    },
    { name: 'link/dropped_samples', type: TypeCode.U32, access: ACCESS_STREAM, value: 0 },
    { name: 'link/dropped_logs', type: TypeCode.U32, access: ACCESS_STREAM, value: 0 },
    {
      name: 'link/credit',
      type: TypeCode.I32,
      access: ACCESS_STREAM,
      value: CREDIT_WINDOW,
    },
    { name: 'link/discarded_frames', type: TypeCode.U32, access: ACCESS_STREAM, value: 0 },
  ];
}

/** The same FNV-1a the firmware hashes its schema with, so the hash matches a real robot's. */
function mix(hash: number, bytes: Uint8Array): number {
  let mixed = hash;

  for (const byte of bytes) {
    mixed = Math.imul(mixed ^ byte, 16777619) >>> 0;
  }

  return mixed;
}

/**
 * The hash of a schema, which is what a monitor keys its schema cache by.
 */
export function schemaHash(variables: readonly Variable[]): number {
  let hash = 2166136261;

  for (const variable of variables) {
    hash = mix(hash, new TextEncoder().encode(variable.name));
    hash = mix(hash, new Uint8Array([variable.type, variable.access]));
    hash = mix(hash, new TextEncoder().encode(variable.typeTag ?? ''));
  }

  return hash;
}
