import { ChevronDownIcon } from 'lucide-react';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import 'uplot/dist/uPlot.min.css';

import { Button } from '../../components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import { useMonitor } from '../../monitor-context';
import { useResolvedColors } from '../shared/document-theme';
import { usePresentedVariables } from '../shared/presented-variables';
import type { WindowViewProps } from '../types';
import { PlotController, type PlotStatus, type PlotTheme } from './plot-controller';
import { layoutAxes, type PlotVariable } from './plot-data';

const PLOT_SPANS_S = [2, 5, 10, 30, 60] as const;
const DEFAULT_PLOT_SPAN_S = 10;
const PLOT_SYNC_KEY = 'micras-monitor/plots';
const NO_STATUS: PlotStatus = { empty: true, dropped: 0, notStored: 0 };
const THEME_COLORS = [
  'var(--muted-foreground)',
  'var(--border)',
  'var(--chart-5)',
  'var(--muted-foreground)',
];
const PLOT_FONT = '11px "Geist Mono Variable", ui-monospace, monospace';

/**
 * A plot of the window's variables over the last seconds, one y axis per unit, drawn by uPlot
 * straight from the history. Paused, it keeps the window it had.
 */
export function PlotWindow({ window, paused }: WindowViewProps) {
  const { history } = useMonitor().ports;
  const presented = usePresentedVariables(window.payload.variables);
  const [spanS, setSpanS] = useState<number>(DEFAULT_PLOT_SPAN_S);
  const [status, setStatus] = useState<PlotStatus>(NO_STATUS);
  const host = useRef<HTMLDivElement>(null);
  const controller = useRef<PlotController | null>(null);
  const colors = useResolvedColors([...THEME_COLORS, ...presented.map(({ color }) => color)]);
  const [axis, grid, dropped, notStored] = colors;
  const theme: PlotTheme = { axis, grid, dropped, notStored, font: PLOT_FONT };
  const variables: readonly PlotVariable[] = presented.map(({ name, presentation }, index) => ({
    name,
    unit: presentation?.unit ?? null,
    color: colors[THEME_COLORS.length + index],
  }));
  const signature = JSON.stringify({ variables, theme });
  const axes = layoutAxes(variables).axes;
  const leftUnit = axes[0]?.unit ?? null;
  const rightUnits = axes
    .slice(1)
    .map((right) => right.unit ?? '—')
    .join(' · ');

  const configure = useEffectEvent((plot: PlotController) => {
    plot.setSpan(spanS * 1e6);
    plot.setPaused(paused);
  });

  useEffect(() => {
    const element = host.current;

    if (element === null) {
      return undefined;
    }

    const described: { variables: readonly PlotVariable[]; theme: PlotTheme } =
      JSON.parse(signature);
    const plot = new PlotController(element, {
      history,
      variables: described.variables,
      spanUs: DEFAULT_PLOT_SPAN_S * 1e6,
      theme: described.theme,
      syncKey: PLOT_SYNC_KEY,
      onStatus: setStatus,
    });
    controller.current = plot;
    configure(plot);
    const observer = new ResizeObserver(([entry]) => {
      plot.resize(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(element);

    return () => {
      observer.disconnect();
      plot.destroy();
      controller.current = null;
    };
  }, [history, signature]);

  useEffect(() => controller.current?.setPaused(paused), [paused]);
  useEffect(() => controller.current?.setSpan(spanS * 1e6), [spanS]);

  const hint =
    variables.length === 0
      ? 'Drag a variable here from the drawer'
      : status.empty
        ? 'Waiting for samples'
        : null;

  return (
    <div className="relative flex h-full flex-col px-3 pb-3">
      {leftUnit === null ? null : (
        <span className="pointer-events-none absolute top-2 left-4 z-10 font-mono text-xs text-muted-foreground">
          {leftUnit}
        </span>
      )}
      <div className="pointer-events-none absolute top-1 right-4 z-10 flex items-center gap-2">
        {status.dropped > 0 ? (
          <span className="rounded-md border border-chart-5/40 bg-card px-2 py-0.5 font-mono text-xs text-chart-5">
            {status.dropped} dropped
          </span>
        ) : null}
        {status.notStored > 0 ? (
          <span className="rounded-md border bg-card px-2 py-0.5 font-mono text-xs text-muted-foreground">
            {status.notStored} not stored
          </span>
        ) : null}
        {rightUnits === '' ? null : (
          <span className="font-mono text-xs text-muted-foreground">{rightUnits} →</span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              className="pointer-events-auto font-mono text-muted-foreground"
              aria-label="Window length"
            >
              {spanS} s
              <ChevronDownIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-24">
            <DropdownMenuRadioGroup
              value={String(spanS)}
              onValueChange={(value) => setSpanS(Number(value))}
            >
              {PLOT_SPANS_S.map((span) => (
                <DropdownMenuRadioItem key={span} value={String(span)} className="font-mono">
                  {span} s
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div
        ref={host}
        data-plot
        data-empty={status.empty}
        className="relative min-h-0 flex-1 overflow-hidden pt-7"
      />
      {hint === null ? null : (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          {hint}
        </div>
      )}
    </div>
  );
}
