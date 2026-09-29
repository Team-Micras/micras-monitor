import { useState } from 'react';

import { isIdleState, roleVariable } from '@/robot-kit';

import { useConnectionStatus, useLiveValue, useRobotPackage } from '../monitor-context';
import type { ConnectionStatus } from '../ports';
import { useSessions } from '../sessions/sessions-context';

/**
 * Why a reload would be unsafe: a recording is under way, the robot is not at rest, or the link is
 * not settled to tell.
 */
export type ReloadBlock = 'recording' | 'not-idle' | 'disconnect';

/** What decides whether the page may reload. */
export interface ReloadFacts {
  readonly link: ConnectionStatus['kind'];
  /** Whether the current state is idle; null when unknown or without a package. */
  readonly idle: boolean | null;
  /** Whether a package names the robot's state. */
  readonly hasPackage: boolean;
  /** Whether the last state seen on this link was idle; null when none was seen. */
  readonly lastIdle: boolean | null;
  /** Whether REC is on, which a reload would cut short. */
  readonly recording?: boolean;
}

/**
 * Tells whether reloading now could cut a run or a recording short. A recording must be stopped
 * first, whatever the robot does. A linked robot must be idle, and with no
 * package to tell, only leaving the link makes it safe. While the link connects or shakes hands
 * the robot may be running, and after it dropped the last state it was seen in decides.
 *
 * @returns The reason to hold the reload back, or null when it is safe.
 */
export function reloadBlock({
  link,
  idle,
  hasPackage,
  lastIdle,
  recording = false,
}: ReloadFacts): ReloadBlock | null {
  if (recording) {
    return 'recording';
  }

  switch (link) {
    case 'linked':
      if (!hasPackage) {
        return 'disconnect';
      }

      return idle === true ? null : 'not-idle';
    case 'connecting':
    case 'handshaking':
      return lastIdle === false ? 'not-idle' : 'disconnect';
    case 'failed':
      return lastIdle === false ? 'disconnect' : null;
    default:
      return null;
  }
}

/** {@link reloadBlock} for the connected robot and REC, following the link and its state. */
export function useReloadBlocked(): ReloadBlock | null {
  const status = useConnectionStatus();
  const recording = (useSessions()?.recording ?? null) !== null;
  const pkg = useRobotPackage()?.package ?? null;
  const stateName = roleVariable(pkg, 'state');
  const value = useLiveValue(stateName)?.value;
  const idle = typeof value === 'number' ? isIdleState(pkg, value) : null;
  const [remembered, setRemembered] = useState<boolean | null>(null);
  const lastIdle =
    status.kind === 'disconnected'
      ? null
      : status.kind === 'linked' && idle !== null
        ? idle
        : remembered;

  if (lastIdle !== remembered) {
    setRemembered(lastIdle);
  }

  return reloadBlock({
    link: status.kind,
    idle,
    hasPackage: stateName !== null,
    lastIdle,
    recording,
  });
}
