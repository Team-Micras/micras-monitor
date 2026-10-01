/**
 * Where `micras_comm` meets the monitor's own model: the type codes of the wire as value types,
 * the access flags of a schema entry as an access, and a schema entry as a variable. Nothing
 * else maps between the two.
 *
 * @module
 */

import type { Access, ValueType, Variable } from '@/core/variables';
import { TypeCode, type Access as WireAccess } from '@/protocol';

import type { SchemaEntry } from './schema';

const VALUE_TYPE: Readonly<Record<TypeCode, ValueType>> = {
  [TypeCode.BOOL]: 'bool',
  [TypeCode.U8]: 'u8',
  [TypeCode.I8]: 'i8',
  [TypeCode.U16]: 'u16',
  [TypeCode.I16]: 'i16',
  [TypeCode.U32]: 'u32',
  [TypeCode.I32]: 'i32',
  [TypeCode.U64]: 'u64',
  [TypeCode.I64]: 'i64',
  [TypeCode.F32]: 'f32',
  [TypeCode.F64]: 'f64',
  [TypeCode.BLOB]: 'bytes',
};

/** The value type a type code stands for. */
export function valueTypeOf(code: TypeCode): ValueType {
  return VALUE_TYPE[code];
}

/** The access a schema entry's flags grant. */
export function accessOf(access: WireAccess): Access {
  return {
    stream: access.stream,
    write: access.write,
    writeNeedsIdle: access.idle,
    persists: access.persist,
  };
}

/** A schema entry as a variable. */
export function variableOf(entry: SchemaEntry): Variable {
  const variable = {
    id: entry.id,
    name: entry.name,
    type: valueTypeOf(entry.type),
    access: accessOf(entry.access),
  };

  return entry.typeTag === undefined ? variable : { ...variable, tag: entry.typeTag };
}
