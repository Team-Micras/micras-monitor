import { ArrowDownIcon } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';

import type { LogEntry, LogSeverity } from '@/core/log';

import { useMonitorState, useShownMonitor } from '../../monitor-context';
import { Button } from '../../primitives/button';
import { cn } from '../../primitives/utils';
import type { WindowViewProps } from '../types';
import { SEVERITIES, entryTime, filterLog, sourceLabel } from './log-filter';

const SEVERITY_DOTS: Readonly<Record<LogSeverity, string>> = {
  debug: 'bg-muted-foreground/50',
  info: 'bg-chart-2',
  warning: 'bg-amber-500',
  error: 'bg-destructive',
};

const SEVERITY_LABELS: Readonly<Record<LogSeverity, string>> = {
  debug: 'All',
  info: 'Info',
  warning: 'Warnings',
  error: 'Errors',
};

const FOLLOW_SLACK_PX = 24;
const keys = new WeakMap<LogEntry, number>();
let nextKey = 0;

function keyOf(entry: LogEntry): number {
  let key = keys.get(entry);

  if (key === undefined) {
    key = nextKey++;
    keys.set(entry, key);
  }

  return key;
}

/**
 * The robot's LOG lines and the link's events, newest at the bottom, filtered by severity, with a
 * count on a link warning noted more than once. It follows new lines until scrolled up, and a
 * paused window keeps the lines it had.
 */
export function LogWindow({ paused }: WindowViewProps) {
  const monitor = useShownMonitor();
  const live = useMonitorState(monitor, (state) => state.log);
  const [frozen, setFrozen] = useState<readonly LogEntry[] | null>(null);
  const [minimum, setMinimum] = useState<LogSeverity>('debug');
  const [following, setFollowing] = useState(true);
  const list = useRef<HTMLOListElement>(null);
  const since = useMonitorState(monitor, (state) =>
    state.status.kind === 'linked' ? state.status.since : null
  );

  if (paused && frozen === null) {
    setFrozen(live);
  } else if (!paused && frozen !== null) {
    setFrozen(null);
  }

  const shown = filterLog(frozen ?? live, minimum);

  useLayoutEffect(() => {
    const element = list.current;

    if (following && element !== null && shown.length > 0) {
      element.scrollTop = element.scrollHeight;
    }
  }, [following, shown]);

  const onScroll = () => {
    const element = list.current;

    if (element !== null) {
      setFollowing(
        element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_SLACK_PX
      );
    }
  };

  return (
    <div className="relative flex h-full flex-col gap-2 px-3 pt-1 pb-3">
      <fieldset className="flex gap-1 px-2">
        <legend className="sr-only">Severity</legend>
        {SEVERITIES.map((severity) => (
          <Button
            key={severity}
            size="xs"
            variant={minimum === severity ? 'secondary' : 'ghost'}
            aria-pressed={minimum === severity}
            className={cn(minimum !== severity && 'text-muted-foreground')}
            onClick={() => setMinimum(severity)}
          >
            {SEVERITY_LABELS[severity]}
          </Button>
        ))}
      </fieldset>
      <ol
        ref={list}
        aria-label="Log"
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-auto px-2 font-mono text-xs leading-6"
      >
        {shown.length === 0 ? (
          <li className="py-6 text-center font-sans text-sm text-muted-foreground">
            Nothing logged yet
          </li>
        ) : (
          shown.map((entry) => (
            <li
              key={keyOf(entry)}
              data-severity={entry.severity}
              data-count={entry.count}
              className="flex items-baseline gap-3"
            >
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {entryTime(entry, since)}
              </span>
              <span
                className={cn(
                  'size-1.5 shrink-0 translate-y-[-1px] rounded-full',
                  SEVERITY_DOTS[entry.severity]
                )}
                aria-hidden
              />
              <span className="sr-only">{entry.severity}</span>
              <span
                className={cn(
                  'min-w-0 break-words',
                  entry.severity === 'debug' && 'text-muted-foreground',
                  entry.severity === 'error' && 'text-destructive'
                )}
              >
                {sourceLabel(entry) === null ? null : (
                  <span className="mr-2 text-muted-foreground">{sourceLabel(entry)}</span>
                )}
                {entry.text}
                {entry.count === undefined ? null : (
                  <span className="ml-2 text-muted-foreground tabular-nums">×{entry.count}</span>
                )}
              </span>
            </li>
          ))
        )}
      </ol>
      {following ? null : (
        <Button
          size="xs"
          variant="secondary"
          className="absolute right-5 bottom-5 shadow-sm"
          onClick={() => setFollowing(true)}
        >
          <ArrowDownIcon />
          Latest
        </Button>
      )}
    </div>
  );
}
