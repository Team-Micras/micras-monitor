import { expect, test } from 'vitest';

import { decodeAccess, MessageType, TypeCode } from '@/protocol';
import type { SchemaPage } from '@/link/messages';
import { SchemaAssembler } from '@/link/schema';

function page(first: number, count: number, total = 6, schemaHash = 0xabc): SchemaPage {
  return {
    type: MessageType.SCHEMA_PAGE,
    schemaHash,
    first,
    total,
    entries: Array.from({ length: count }, (_, offset) => ({
      type: TypeCode.F32,
      access: 0x01,
      name: `v${first + offset}`,
      typeTag: null,
    })),
  };
}

test('assembles consecutive pages', () => {
  const schema = new SchemaAssembler(0xabc, 6);

  expect(schema.accept(page(0, 3))).toBe('progress');
  expect(schema.accept(page(3, 3))).toBe('complete');
  expect(schema.result().map((entry) => entry.name)).toEqual(['v0', 'v1', 'v2', 'v3', 'v4', 'v5']);
  expect(schema.result()[4]).toMatchObject({ id: 4, type: TypeCode.F32, access: { stream: true } });
});

test('reports a lost page and where to start again', () => {
  const schema = new SchemaAssembler(0xabc, 6);

  schema.accept(page(0, 2));

  expect(schema.accept(page(4, 2))).toBe('gap');
  expect(schema.firstMissing).toBe(2);
  expect(schema.accept(page(2, 4))).toBe('complete');
});

test('ignores pages of another schema', () => {
  const schema = new SchemaAssembler(0xabc, 6);

  expect(schema.accept(page(0, 3, 6, 0xdef))).toBe('ignored');
  expect(schema.accept(page(0, 3, 7))).toBe('ignored');
  expect(schema.received).toBe(0);
});

test('refuses to hand out an incomplete schema', () => {
  const schema = new SchemaAssembler(0xabc, 6);

  schema.accept(page(0, 3));

  expect(() => schema.result()).toThrow('3 of 6');
});

test('refuses a page that names a type it does not know', () => {
  const schema = new SchemaAssembler(0xabc, 6);
  const bad = page(0, 3);
  const unknownType: number = 42;
  bad.entries[1] = { ...bad.entries[1], type: unknownType };

  expect(schema.accept(bad)).toBe('invalid');
  expect(schema.received).toBe(0);
});

test('keeps the type tag of a blob', () => {
  const schema = new SchemaAssembler(0xabc, 1);

  schema.accept({
    type: MessageType.SCHEMA_PAGE,
    schemaHash: 0xabc,
    first: 0,
    total: 1,
    entries: [{ type: TypeCode.BLOB, access: 0x08, name: 'maze', typeTag: 'maze-grid' }],
  });

  expect(schema.result()).toEqual([
    { id: 0, name: 'maze', type: TypeCode.BLOB, access: decodeAccess(0x08), typeTag: 'maze-grid' },
  ]);
});
