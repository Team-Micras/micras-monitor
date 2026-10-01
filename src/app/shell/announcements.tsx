import { useEffect, useEffectEvent, useRef } from 'react';

import { roleVariable, enumLabel } from '@/core/robot';

import type { SourceStatus } from '@/core/source';

import { useLiveMonitor, useLiveValue, useRobotPackage, useStatus } from '../monitor-context';
import { useSessions } from '../sessions/sessions-context';
import { useShell } from '../state/shell-store';
import { usePresentedVariables } from '../windows/shared/presented-variables';
import { useAnnounce } from './announce';

function connectionText(status: SourceStatus): string | null {
  switch (status.kind) {
    case 'connecting':
      return 'Connecting to the robot';
    case 'linked':
      return `Connected to ${status.identity.name ?? 'the robot'}`;
    case 'failed':
      return `Connection failed: ${status.message}`;
    case 'disconnected':
      return 'Disconnected';
    default:
      return null;
  }
}

function useChanges<T>(value: T, onChange: (value: T, previous: T) => void): void {
  const previous = useRef(value);
  const changed = useEffectEvent(onChange);

  useEffect(() => {
    if (previous.current !== value) {
      changed(value, previous.current);
      previous.current = value;
    }
  }, [value]);
}

/**
 * Turns the few events a user must not miss into announcements: connection changes, the robot's
 * state, what a command sent from the shell came to (assertively), and recording starting and
 * stopping. It reads events, never samples: the state is announced when its label changes, not
 * while it holds.
 * Command refusals and failed windows announce from where they happen.
 */
export function Announcements() {
  const announce = useAnnounce();
  const monitor = useLiveMonitor();
  const status = useStatus(monitor);
  const pkg = useRobotPackage(monitor)?.package ?? null;
  const stateName = roleVariable(pkg, 'state');
  const [state] = usePresentedVariables(monitor, stateName === null ? [] : [stateName]);
  const raw = useLiveValue(monitor, stateName)?.value;
  const labels = state?.presentation?.labels?.kind === 'enum' ? state.presentation.labels : null;
  const linked = status.kind === 'linked';
  const stateText =
    linked && typeof raw === 'number'
      ? `Robot state: ${labels === null ? raw : enumLabel(labels, raw)}`
      : null;
  const notice = useShell((shell) => shell.commandNotice);
  const settled = notice !== null && notice.tone !== 'pending' ? notice : null;
  const recording = (useSessions()?.recording ?? null) !== null;

  useChanges(status.kind, () => {
    const text = connectionText(status);

    if (text !== null) {
      announce(text);
    }
  });

  useChanges(stateText, (text, before) => {
    if (text !== null && before !== null) {
      announce(text);
    }
  });

  useChanges(settled, (answer) => {
    if (answer !== null) {
      announce(answer.text, 'assertive');
    }
  });

  useChanges(recording, (now) => announce(now ? 'Recording started' : 'Recording stopped'));

  return null;
}
