import { useLiveValue } from '../../monitor-context';
import { cn } from '../../lib/utils';
import { usePresentedVariables, type PresentedVariable } from '../shared/presented-variables';
import { formatReading, isStale } from '../shared/readings';
import { READOUT_RATE_HZ } from '../rates';
import { useLinkLive, useSessionEnd, useStaleAfter } from '../shared/session-end';
import type { WindowViewProps } from '../types';

/**
 * The latest values of the window's variables, large, with their units, ten times a second.
 * A value that stopped arriving fades and says so.
 */
export function ReadoutsWindow({ window }: WindowViewProps) {
  const presented = usePresentedVariables(window.payload.variables);
  const sessionEndUs = useSessionEnd();
  const live = useLinkLive();

  if (presented.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Drag a variable here from the drawer
      </div>
    );
  }

  return (
    <dl className="grid h-full auto-rows-min grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] content-center gap-x-6 gap-y-7 overflow-auto px-6 py-5">
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
  const latest = useLiveValue(entry.name);
  const staleAfterUs = useStaleAfter(entry.name, READOUT_RATE_HZ);
  const stale = isStale(latest, sessionEndUs, live, staleAfterUs);
  const unit = entry.presentation?.unit ?? null;

  return (
    <div data-readout={entry.name} data-stale={stale} className="flex min-w-0 flex-col gap-1.5">
      <dt className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
        <span className="truncate">{entry.name}</span>
        {entry.variable === undefined ? <span>· not in schema</span> : null}
        {stale ? <span className="rounded border px-1 text-[10px] uppercase">stale</span> : null}
      </dt>
      <dd
        className={cn(
          'flex items-baseline gap-1.5 font-mono text-3xl font-medium tracking-tight tabular-nums transition-opacity',
          stale && 'opacity-45'
        )}
      >
        <span className="truncate">
          {formatReading(latest?.value, entry.presentation?.labels ?? null)}
        </span>
        {unit === null ? null : (
          <span className="text-sm font-normal text-muted-foreground">{unit}</span>
        )}
      </dd>
    </div>
  );
}
