/**
 * What the app asks the live robot to stream: the demands of the windows on screen and the roles
 * the robot package pins, handed to the live monitor whenever they change.
 *
 * @module
 */

import { useEffect } from 'react';

import type { VariableDemand } from '@/core/monitor';
import type { Role, RobotPackage } from '@/core/robot';
import { activeWorkspace, windowIds, type Desktop } from '@/tiling';

import { useLiveMonitor, useRobotPackage } from './monitor-context';
import { useShell } from './state/shell-store';
import { windowDemand } from './windows/registry';
import type { ShellWindow, WindowPayload } from './windows/types';

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

/**
 * What to stream for windows that are on screen and the package of the connected robot, if any:
 * the roles the package pins first, which the source cuts last, then what the windows ask for.
 */
export function streamDemands(
  shown: readonly ShellWindow[],
  pkg: RobotPackage | null
): VariableDemand[] {
  const pinned = PINNED_RATES_HZ.flatMap(([role, rateHz]) => {
    const variable = pkg?.roles[role];
    return variable === undefined ? [] : [{ variable, rateHz, role }];
  });

  return [...pinned, ...shown.flatMap((window) => windowDemand(window, pkg))];
}

/**
 * Keeps the live monitor told what the visible windows and the pinned roles want, again after
 * every change of the desktop or the package; the source leaves the robot alone when the plan
 * comes out the same.
 *
 * @param phone The windows of the phone view, which stand for the desktop while it is drawn.
 */
export function useStreamDemand(phone: readonly ShellWindow[] | null = null): void {
  const live = useLiveMonitor();
  const desktop = useShell((state) => state.desktop);
  const pkg = useRobotPackage(live)?.package ?? null;
  const shown = phone ?? visibleWindows(desktop).flatMap((id) => desktop.windows.get(id) ?? []);
  const demands = streamDemands(shown, pkg);

  useEffect(() => live.request(demands), [live, demands]);
}
