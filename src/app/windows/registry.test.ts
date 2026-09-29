import { describe, expect, test } from 'vitest';

import { mouse } from '@/robot-kit/fixtures/packages';

import { BATTERY_RATE_HZ, POSE_RATE_HZ, READOUT_RATE_HZ, REVISION_RATE_HZ } from './rates';
import { windowDemand } from './registry';
import type { ShellWindow } from './types';

const PACKAGE = mouse({
  roles: { state: 'state', battery: 'battery', map: 'maze', 'map.revision': 'maze/revision' },
});

const win = (kind: string, variables: readonly string[] = []): ShellWindow => ({
  id: kind,
  kind,
  payload: { variables },
});

describe('windowDemand', () => {
  test('asks for the Robot window by the roles of the package', () => {
    expect(windowDemand(win('robot', ['stale_name']), PACKAGE)).toEqual([
      { variable: 'state', rateHz: READOUT_RATE_HZ },
      { variable: 'battery', rateHz: BATTERY_RATE_HZ },
    ]);
    expect(windowDemand(win('robot'), null)).toEqual([]);
  });

  test('asks a type view for the revision of the map, not the blob', () => {
    expect(windowDemand(win('type-view', ['maze']), PACKAGE)).toEqual([
      { variable: 'maze/revision', rateHz: REVISION_RATE_HZ },
    ]);
    expect(windowDemand(win('type-view', ['grid']), PACKAGE)).toEqual([]);
  });

  test('asks the view of the map for the pose the package names', () => {
    const posed = mouse({
      roles: { ...PACKAGE.roles, 'pose.x': 'x', 'pose.y': 'y', 'pose.heading': 'theta' },
    });
    expect(windowDemand(win('type-view', ['maze']), posed)).toEqual([
      { variable: 'maze/revision', rateHz: REVISION_RATE_HZ },
      { variable: 'x', rateHz: POSE_RATE_HZ },
      { variable: 'y', rateHz: POSE_RATE_HZ },
      { variable: 'theta', rateHz: POSE_RATE_HZ },
    ]);
  });

  test('asks for the variables of the other kinds, and for none of the views without any', () => {
    expect(windowDemand(win('readouts', ['battery']))).toEqual([
      { variable: 'battery', rateHz: READOUT_RATE_HZ },
    ]);
    expect(windowDemand(win('commands'), PACKAGE)).toEqual([]);
  });
});
