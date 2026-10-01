import { describe, expect, test } from 'vitest';

import { mouse, sumo } from '@tests/support/robot-kit/packages';
import { PackageError, RobotRegistry } from '@/robot-kit';

describe('registering packages', () => {
  test('lists packages in registration order and finds them by id', () => {
    const registry = new RobotRegistry([sumo(), mouse()]);
    expect(registry.list().map((pkg) => pkg.id)).toEqual(['sumo', 'mouse']);
    expect(registry.get('mouse')?.displayName).toBe('Mouse');
    expect(registry.get('nobody')).toBeUndefined();
  });

  test('rejects a second package with the same id', () => {
    const registry = new RobotRegistry([mouse()]);
    expect(() => registry.register(mouse())).toThrow(
      new PackageError('mouse', 'id', 'is already registered')
    );
  });

  test('rejects an inconsistent package before adding it', () => {
    const registry = new RobotRegistry<string>();
    expect(() => registry.register(mouse({ id: '' }))).toThrow('id must be a non-empty string');
    expect(registry.list()).toEqual([]);
  });
});

describe('choosing the package of a robot', () => {
  const registry = new RobotRegistry([mouse(), sumo()]);

  test('a robot that announces a name gets the package with that id', () => {
    expect(registry.select({ name: 'sumo', variables: [] })).toEqual({
      package: registry.get('sumo'),
      matchedBy: 'name',
    });
  });

  test('an unknown name means raw mode even when the variables would match', () => {
    expect(registry.select({ name: 'stranger', variables: ['state', 'profile'] })).toBeNull();
  });

  test('without a name, the package whose whole signature is in the schema is chosen', () => {
    const selection = registry.select({ name: null, variables: ['profile', 'x', 'state'] });
    expect(selection?.package.id).toBe('mouse');
    expect(selection?.matchedBy).toBe('variables');
  });

  test('the longest matching signature wins', () => {
    const selection = registry.select({ name: null, variables: ['state', 'profile', 'blade'] });
    expect(selection?.package.id).toBe('sumo');
  });

  test('a partial signature does not match', () => {
    expect(registry.select({ name: null, variables: ['state'] })).toBeNull();
  });

  test('a tie between the longest signatures means raw mode rather than a guess', () => {
    const tied = new RobotRegistry([mouse(), sumo({ signature: ['profile', 'state'] })]);
    expect(tied.select({ name: null, variables: ['state', 'profile'] })).toBeNull();
  });

  test('an empty signature never matches', () => {
    const blank = new RobotRegistry([mouse({ signature: [] })]);
    expect(blank.select({ name: null, variables: ['state', 'profile'] })).toBeNull();
  });

  test('no packages means raw mode', () => {
    expect(new RobotRegistry().select({ name: 'mouse', variables: [] })).toBeNull();
  });
});
