import { TriangleAlertIcon } from 'lucide-react';

import type { Gauge } from '@/core/source';

import { useMonitorState, useShownMonitor, useVariables } from '../../monitor-context';
import { cn } from '../../primitives/utils';
import type { WindowViewProps } from '../types';
import { formatHz, formatRate, isCut, orderedStreams, share } from './link-summary';

/**
 * The connection's health: the rate it carries, what it lost and its round trip, the gauges the
 * source measures, such as credit and budget, and the rates it granted against the ones the
 * windows asked for.
 */
export function LinkWindow(_props: WindowViewProps) {
  const monitor = useShownMonitor();
  const stats = useMonitorState(monitor, (state) => state.stats);
  const streams = orderedStreams(stats.streams, useVariables(monitor));
  const cut = streams.filter(isCut).length;

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
      {stats.gauges.map((gauge) => (
        <Meter key={gauge.label} gauge={gauge} />
      ))}
      {cut > 0 ? <OverBudget cut={cut} /> : null}
      {streams.length === 0 ? null : (
        <section
          aria-label="Streams"
          // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region must be reachable by keyboard
          tabIndex={0}
          className="-mx-2 min-h-0 flex-1 overflow-auto px-2"
        >
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
                    {formatHz(stream.askedHz)}
                  </td>
                  <td className={cn('py-1 text-right', isCut(stream) && 'text-amber-500')}>
                    {formatHz(stream.grantedHz)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
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

function gaugeDetail({ used, capacity, unit }: Gauge): string {
  return unit === 'B/s'
    ? `${formatRate(used)} of ${formatRate(capacity)}`
    : `${Math.round(used)} / ${Math.round(capacity)} B`;
}

function Meter({ gauge }: { readonly gauge: Gauge }) {
  const { label, used, capacity, warn } = gauge;
  const ratio = share(used, capacity);
  const detail = gaugeDetail(gauge);

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

function OverBudget({ cut }: { readonly cut: number }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-amber-500/40 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
    >
      <TriangleAlertIcon className="mt-px size-3.5 shrink-0" aria-hidden />
      The windows ask for more than the link carries: {cut}{' '}
      {cut === 1 ? 'stream runs' : 'streams run'} slower than asked.
    </p>
  );
}
