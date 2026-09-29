import { TriangleAlertIcon } from 'lucide-react';
import { useSyncExternalStore } from 'react';

import { cn } from '../../lib/utils';
import { useMonitor } from '../../monitor-context';
import type { LinkStats } from '../../ports';
import type { WindowViewProps } from '../types';
import { formatHz, formatRate, isCut, orderedStreams, share } from './link-summary';

/**
 * The link's health: the rate it carries, its credit, what it lost and its round trip, and the
 * stream planner's budget with the rates it granted against the ones the windows asked for.
 */
export function LinkWindow(_props: WindowViewProps) {
  const { link } = useMonitor().ports;
  const stats = useSyncExternalStore(
    (listener) => link.subscribe(listener),
    () => link.stats()
  );
  const { budget } = stats;
  const streams = orderedStreams(budget);

  return (
    <div className="flex h-full flex-col gap-5 overflow-hidden px-5 pt-1 pb-5">
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] gap-x-5 gap-y-4">
        <Figure label="Rate" value={formatRate(stats.bytesInPerSecond)} />
        <Figure
          label="Round trip"
          value={Number.isFinite(stats.rttMs) ? `${Math.round(stats.rttMs)} ms` : '—'}
        />
        <Figure
          label="Dropped"
          value={String(stats.samplesDropped)}
          warn={stats.samplesDropped > 0}
        />
        <Figure
          label="Discarded"
          value={String(stats.framesDiscarded)}
          warn={stats.framesDiscarded > 0}
        />
      </dl>
      <Meter
        label="Credit"
        detail={`${stats.creditOutstanding} / ${stats.creditWindow} B`}
        ratio={share(stats.creditOutstanding, stats.creditWindow)}
      />
      <Meter
        label="Budget"
        detail={`${formatRate(budget.used)} of ${formatRate(budget.bytesPerSecond)}`}
        ratio={share(budget.used, budget.bytesPerSecond)}
        warn={budget.overBudget}
      />
      {budget.overBudget ? <OverBudget stats={stats} /> : null}
      {streams.length === 0 ? null : (
        <div className="-mx-2 min-h-0 flex-1 overflow-auto px-2">
          <table className="w-full font-mono text-xs tabular-nums">
            <thead className="sticky top-0 bg-card text-muted-foreground">
              <tr>
                <th className="py-1.5 text-left font-normal">variable</th>
                <th className="py-1.5 pl-4 text-right font-normal">asked</th>
                <th className="py-1.5 pl-4 text-right font-normal">granted Hz</th>
              </tr>
            </thead>
            <tbody>
              {streams.map((stream) => (
                <tr key={stream.variable} data-cut={isCut(stream)}>
                  <td className="truncate py-1 pr-3">{stream.variable}</td>
                  <td className="py-1 text-right text-muted-foreground">
                    {formatHz(stream.rateHz)}
                  </td>
                  <td className={cn('py-1 text-right', isCut(stream) && 'text-amber-500')}>
                    {formatHz(stream.grantedHz)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Figure({
  label,
  value,
  warn = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly warn?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('font-mono text-lg font-medium tabular-nums', warn && 'text-amber-500')}>
        {value}
      </dd>
    </div>
  );
}

function Meter({
  label,
  detail,
  ratio,
  warn = false,
}: {
  readonly label: string;
  readonly detail: string;
  readonly ratio: number;
  readonly warn?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono tabular-nums">{detail}</span>
      </div>
      <div aria-hidden className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            'h-full rounded-full transition-[width]',
            warn ? 'bg-amber-500' : 'bg-foreground/70'
          )}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
    </div>
  );
}

function OverBudget({ stats }: { readonly stats: LinkStats }) {
  const cut = stats.budget.planned.filter(isCut).length;

  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-amber-500/40 px-3 py-2 text-xs text-amber-600 dark:text-amber-400"
    >
      <TriangleAlertIcon className="mt-px size-3.5 shrink-0" aria-hidden />
      The windows ask for more than the link carries: {cut}{' '}
      {cut === 1 ? 'stream runs' : 'streams run'} slower than asked.
    </p>
  );
}
