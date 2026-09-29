/**
 * What the app asks the link to stream: the demands of the windows on screen and the roles the
 * robot package pins, handed to the stream port whenever they change.
 *
 * @module
 */

import { useEffect } from 'react';

import type { Role, RobotPackage } from '@/robot-kit';
import { activeWorkspace, windowIds, type Desktop } from '@/tiling';

import { useMonitor, useRobotPackage } from './monitor-context';
import type { PinnedDemand, StreamDemand, StreamRequest } from './ports';
import { useShell } from './state/shell-store';
import { windowDemand } from './windows/registry';
import type { WindowPayload } from './windows/types';

/** The roles streamed whatever is on screen, and how often. */
export const PINNED_RATES_HZ: readonly (readonly [role: Role, rateHz: number])[] = [
  ['state', 10],
  ['battery', 1],
  ['link.dropped', 1],
  ['link.credit', 2],
];

/** The windows of the active workspace that are on screen: all but those behind a maximized one. */
export function visibleWindows(desktop: Desktop<WindowPayload>): readonly string[] {
  const workspace = activeWorkspace(desktop);

  return workspace.maximized === null
    ? windowIds(workspace)
    : [workspace.maximized, ...workspace.floating.map((entry) => entry.id)];
}

/** What to stream for a desktop and the package of the connected robot, if any. */
export function streamRequest(
  desktop: Desktop<WindowPayload>,
  pkg: RobotPackage | null
): StreamRequest {
  const windows: StreamDemand[] = visibleWindows(desktop).flatMap((id) => {
    const window = desktop.windows.get(id);
    return window ? windowDemand(window) : [];
  });
  const pinned: PinnedDemand[] = PINNED_RATES_HZ.flatMap(([role, rateHz]) => {
    const variable = pkg?.roles[role];
    return variable === undefined ? [] : [{ role, variable, rateHz }];
  });

  return { windows, pinned };
}

/**
 * Keeps the stream port told what the visible windows and the pinned roles want, again after
 * every change of the desktop or the package; the planner leaves the robot alone when the groups
 * come out the same.
 */
export function useStreamDemand(): void {
  const { streams } = useMonitor().ports;
  const desktop = useShell((state) => state.desktop);
  const pkg = useRobotPackage()?.package ?? null;
  const request = streamRequest(desktop, pkg);

  useEffect(() => streams.request(request), [streams, request]);
}
