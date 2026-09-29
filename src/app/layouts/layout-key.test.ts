import { describe, expect, test } from 'vitest';

import { layoutKey, nameSetSignature, overlap } from './layout-key';

describe('the key of a robot', () => {
  test('is the package id when a package draws the robot, whatever it announced', () => {
    expect(layoutKey({ packageId: 'micras', name: 'micras', variables: ['a'] })).toBe(
      'package:micras'
    );
    expect(layoutKey({ packageId: 'micras', name: null, variables: ['a'] })).toBe('package:micras');
  });

  test('is the announced name in raw mode', () => {
    expect(layoutKey({ packageId: null, name: 'rover', variables: ['a'] })).toBe('name:rover');
  });

  test('is the signature of the variable names when there is neither', () => {
    const key = layoutKey({ packageId: null, name: null, variables: ['b', 'a'] });
    expect(key).toBe(`signature:${nameSetSignature(['a', 'b'])}`);
  });
});

describe('the signature of a set of names', () => {
  test('does not depend on the order or on repeats', () => {
    expect(nameSetSignature(['x', 'y', 'z'])).toBe(nameSetSignature(['z', 'x', 'y', 'x']));
  });

  test('changes with the names, and has a fixed size', () => {
    expect(nameSetSignature(['x', 'y'])).not.toBe(nameSetSignature(['x', 'y', 'z']));
    expect(nameSetSignature(['ab', 'c'])).not.toBe(nameSetSignature(['a', 'bc']));
    expect(nameSetSignature([])).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('the overlap of two sets of names', () => {
  test('is the shared names over all the names', () => {
    expect(overlap(['a', 'b'], ['b', 'a'])).toBe(1);
    expect(overlap(['a', 'b', 'c'], ['a', 'b', 'c', 'd'])).toBe(0.75);
    expect(overlap(['a'], ['b'])).toBe(0);
    expect(overlap([], [])).toBe(1);
  });
});
