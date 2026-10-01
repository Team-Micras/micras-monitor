import { BatteryMediumIcon } from 'lucide-react';
import { useSyncExternalStore } from 'react';

import type { LogEntry } from '@/core/log';
import { enumLabel, roleVariable, type EnumType } from '@/core/robot';
import type { HistoryStore } from '@/history';

import { formatClock, formatValue } from '../../lib/format';
import {
  useLinkUp,
  useLiveValue,
  useMonitorState,
  useRobotPackage,
  useShownMonitor,
  type AppMonitor,
} from '../../monitor-context';
import { cn } from '../../primitives/utils';
import { READOUT_RATE_HZ } from '../rates';
import { usePresentedVariables } from '../shared/presented-variables';
import { useLinkLive, useSessionEnd, useStaleAfter } from '../shared/session-end';
import { isStale } from '../shared/value-text';
import type { WindowViewProps } from '../types';
import { loggedTransitions, mergeTransitions, type StateLogReader } from './logged-transitions';
import { TransitionTracker, type Transition } from './transitions';

const SHOWN_TRANSITIONS = 5;
const NO_TRANSITIONS: readonly Transition[] = [];
const trackers = new WeakMap<HistoryStore, Map<string, TransitionTracker>>();

function trackerFor(history: HistoryStore, name: string): TransitionTracker {
  let byName = trackers.get(history);

  if (byName === undefined) {
    byName = new Map();
    trackers.set(history, byName);
  }

  let tracker = byName.get(name);

  if (tracker === undefined) {
    tracker = new TransitionTracker(history, name);
    byName.set(name, tracker);
  }

  return tracker;
}

function useTransitions(monitor: AppMonitor, name: string | null): readonly Transition[] {
  const { history } = monitor;
  return useSyncExternalStore(
    (listener) => (name === null ? () => undefined : history.subscribe([name], listener)),
    () => (name === null ? NO_TRANSITIONS : trackerFor(history, name).update())
  );
}

const NO_ENTRIES: readonly LogEntry[] = [];

function useLogEntries(monitor: AppMonitor, follow: boolean): readonly LogEntry[] {
  return useMonitorState(monitor, (state) => (follow ? state.log : NO_ENTRIES));
}

function timelineOf(
  sampled: readonly Transition[],
  entries: readonly LogEntry[],
  read: StateLogReader | undefined
): readonly Transition[] {
  return read === undefined ? sampled : mergeTransitions(loggedTransitions(entries, read), sampled);
}

function labelOf(labels: EnumType | null, value: number): string {
  return labels === null ? String(value) : enumLabel(labels, value);
}

/**
 * The robot by the roles its package gives: the state with its label and how long it has been in
 * it, from the live value; the last transitions, from the robot's log when the package reads it
 * and from the sampled state otherwise and where the log has gaps; and the battery.
 */
export function RobotWindow(_props: WindowViewProps) {
  const monitor = useShownMonitor();
  const pkg = useRobotPackage(monitor)?.package ?? null;
  const stateName = roleVariable(pkg, 'state');
  const batteryName = roleVariable(pkg, 'battery');
  const [state, battery] = usePresentedVariables(monitor, [stateName ?? '', batteryName ?? '']);
  const stateLabels =
    state.presentation?.labels?.kind === 'enum' ? state.presentation.labels : null;
  const current = useLiveValue(monitor, stateName);
  const sampled = useTransitions(monitor, stateName);
  const read = pkg?.stateLog;
  const entries = useLogEntries(monitor, read !== undefined);
  const transitions = timelineOf(sampled, entries, read);
  const sessionEndUs = useSessionEnd(monitor);
  const live = useLinkLive(monitor);
  const linked = useLinkUp(monitor);
  const stateStaleAfterUs = useStaleAfter(monitor, stateName, READOUT_RATE_HZ);

  if (pkg === null) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {linked
          ? 'No robot package names the state or the battery of this robot'
          : 'Connect to a robot to see its state'}
      </div>
    );
  }

  const since = sampled.at(-1);
  const shown = transitions.slice(-SHOWN_TRANSITIONS);
  const stale = isStale(current, sessionEndUs, live, stateStaleAfterUs);

  return (
    <div className="flex h-full flex-col justify-between gap-6 overflow-auto px-5 pt-2 pb-5">
      <div className="flex flex-col gap-5">
        <div className="flex items-baseline gap-3">
          <span
            data-robot-state
            className={cn('text-3xl font-semibold tracking-tight', stale && 'opacity-45')}
          >
            {typeof current?.value === 'number' ? labelOf(stateLabels, current.value) : '—'}
          </span>
          {since !== undefined && sessionEndUs !== undefined ? (
            <span className="ml-auto font-mono text-xs text-muted-foreground tabular-nums">
              for {formatClock((sessionEndUs - since.timeUs) / 1000)}
            </span>
          ) : null}
        </div>
        {shown.length === 0 ? null : (
          <ol
            aria-label="State transitions"
            className="grid gap-2"
            style={{ gridTemplateColumns: `repeat(${SHOWN_TRANSITIONS}, minmax(0, 1fr))` }}
          >
            {shown.map((transition, index) => (
              <li key={transition.timeUs} className="flex min-w-0 flex-col gap-1.5">
                <span className="flex items-center">
                  <span
                    className={cn(
                      'size-2.5 shrink-0 rounded-full border-2',
                      index === shown.length - 1
                        ? 'border-foreground bg-foreground'
                        : 'border-muted-foreground'
                    )}
                  />
                  {index === shown.length - 1 ? null : <span className="h-px flex-1 bg-border" />}
                </span>
                <span className="truncate font-mono text-xs">
                  {labelOf(stateLabels, transition.value)}
                </span>
                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                  {formatClock(transition.timeUs / 1000)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
      {batteryName === null ? null : (
        <Battery
          name={batteryName}
          unit={battery.presentation?.unit ?? null}
          sessionEndUs={sessionEndUs}
          live={live}
        />
      )}
    </div>
  );
}

function Battery({
  name,
  unit,
  sessionEndUs,
  live,
}: {
  readonly name: string;
  readonly unit: string | null;
  readonly sessionEndUs: number | undefined;
  readonly live: boolean;
}) {
  const monitor = useShownMonitor();
  const latest = useLiveValue(monitor, name);
  const value = latest?.value;
  const staleAfterUs = useStaleAfter(monitor, name, READOUT_RATE_HZ);
  const stale = isStale(latest, sessionEndUs, live, staleAfterUs);

  return (
    <div data-battery className="flex items-center gap-2 border-t pt-4">
      <BatteryMediumIcon className="size-4 text-muted-foreground" aria-hidden />
      <span className="text-sm text-muted-foreground">Battery</span>
      <span
        className={cn('ml-auto font-mono text-xl font-medium tabular-nums', stale && 'opacity-45')}
      >
        {typeof value === 'number' ? value.toFixed(2) : formatValue(value)}
      </span>
      {unit === null ? null : <span className="text-sm text-muted-foreground">{unit}</span>}
    </div>
  );
}
