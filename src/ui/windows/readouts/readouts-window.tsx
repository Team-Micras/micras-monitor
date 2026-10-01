import { useLiveValue, useShownMonitor } from '../../monitor-context';
import { cn } from '../../primitives/utils';
import { READOUT_RATE_HZ } from '../stream-rates';
import { usePresentedVariables, type PresentedVariable } from '../shared/presented-variables';
import { useLinkLive, useSessionEnd, useStaleAfter } from '../shared/session-end';
import { formatReading, isStale } from '../shared/value-text';
import type { WindowViewProps } from '../types';

/**
 * The latest values of the window's variables, large, with their units, ten times a second.
 * A value that stopped arriving fades and says so.
 */
export function ReadoutsWindow({ window }: WindowViewProps) {
  const monitor = useShownMonitor();
  const presented = usePresentedVariables(monitor, window.payload.variables);
  const sessionEndUs = useSessionEnd(monitor);
  const live = useLinkLive(monitor);

  if (presented.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Drag a variable here from the drawer
      </div>
    );
  }

  return (
    <dl className="grid h-full auto-rows-min grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] content-center gap-x-6 gap-y-7 overflow-auto px-6 py-5">
      {presented.map((entry) => (
        <Readout key={entry.name} entry={entry} sessionEndUs={sessionEndUs} live={live} />
      ))}
    </dl>
  );
}

function Readout({
  entry,
  sessionEndUs,
  live,
}: {
  readonly entry: PresentedVariable;
  readonly sessionEndUs: number | undefined;
  readonly live: boolean;
}) {
  const monitor = useShownMonitor();
  const latest = useLiveValue(monitor, entry.name);
  const staleAfterUs = useStaleAfter(monitor, entry.name, READOUT_RATE_HZ);
  const stale = isStale(latest, sessionEndUs, live, staleAfterUs);
  const unit = entry.presentation?.unit ?? null;

  return (
    <div
      data-readout={entry.name}
      data-stale={stale}
      data-missing={entry.missing}
      className={cn('flex min-w-0 flex-col gap-1.5', entry.missing && 'opacity-60')}
    >
      <dt className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
        <span className="truncate">{entry.name}</span>
        {entry.missing ? (
          <span className="rounded border px-1 text-[10px] uppercase">missing</span>
        ) : null}
        {stale ? <span className="rounded border px-1 text-[10px] uppercase">stale</span> : null}
      </dt>
      <dd
        className={cn(
          'flex items-baseline gap-1.5 font-mono text-3xl font-medium tracking-tight tabular-nums transition-opacity',
          stale && 'opacity-45'
        )}
      >
        <span className="truncate">
          {formatReading(latest?.value, entry.presentation?.labels ?? null, entry.variable?.type)}
        </span>
        {unit === null ? null : (
          <span className="text-sm font-normal text-muted-foreground">{unit}</span>
        )}
      </dd>
    </div>
  );
}
