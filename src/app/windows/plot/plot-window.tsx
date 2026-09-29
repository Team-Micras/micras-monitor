import { ChevronDownIcon, Undo2Icon } from 'lucide-react';
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
import { useShellStore } from '../../state/shell-store';
import { useResolvedColors } from '../shared/document-theme';
import { usePresentedVariables } from '../shared/presented-variables';
import type { HistoryPort } from '../../ports';
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
 * straight from the history. Paused, it keeps the window it had. Dragging it, the wheel and, with
 * the window focused, the arrow keys, + and − and Home move it through the whole history, which
 * pauses it; End or Live follow the newest samples again.
 */
export function PlotWindow({ window, paused, visible }: WindowViewProps) {
  const { history } = useMonitor().ports;
  const shell = useShellStore();
  const presented = usePresentedVariables(window.payload.variables);
  const [spanS, setSpanS] = useState<number>(DEFAULT_PLOT_SPAN_S);
  const [status, setStatus] = useState<PlotStatus>(NO_STATUS);
  const host = useRef<HTMLDivElement>(null);
  const controller = useRef<PlotController | null>(null);
  const applied = useRef<string | null>(null);
  const colors = useResolvedColors([...THEME_COLORS, ...presented.map(({ color }) => color)]);
  const [axis, grid, dropped, notStored] = colors;
  const theme: PlotTheme = { axis, grid, dropped, notStored, font: PLOT_FONT };
  const variables: readonly PlotVariable[] = presented.map(({ name, presentation }, index) => ({
    name,
    unit: presentation?.unit ?? null,
    color: colors[THEME_COLORS.length + index],
  }));
  const axes = layoutAxes(variables).axes;
  const leftUnit = axes[0]?.unit ?? null;
  const rightUnits = axes
    .slice(1)
    .map((right) => right.unit ?? '—')
    .join(' · ');

  const style = [...colors, ...variables.map(({ name, unit }) => `${name} ${unit ?? ''}`)].join(
    '\n'
  );

  const create = useEffectEvent((element: HTMLElement, source: HistoryPort) => {
    const plot = new PlotController(element, {
      history: source,
      variables,
      spanUs: spanS * 1e6,
      theme,
      syncKey: PLOT_SYNC_KEY,
      keys: element.closest<HTMLElement>('[data-window]') ?? element,
      onStatus: setStatus,
      onDraw: (milliseconds, shown) => {
        element.dataset.drawMs = milliseconds.toFixed(2);
        element.dataset.draws = String(Number(element.dataset.draws ?? 0) + 1);
        element.dataset.windowStartUs = String(shown.startUs);
        element.dataset.windowEndUs = String(shown.endUs);
      },
      onNavigate: () => shell.getState().setPaused(window.id, true),
      onResume: () => shell.getState().setPaused(window.id, false),
    });
    plot.setPaused(paused);
    plot.setVisible(visible);
    applied.current = style;
    return plot;
  });

  const restyle = useEffectEvent((next: string) => {
    if (controller.current !== null && applied.current !== next) {
      controller.current.restyle(variables, theme);
      applied.current = next;
    }
  });

  useEffect(() => {
    const element = host.current;

    if (element === null) {
      return undefined;
    }

    const plot = create(element, history);
    controller.current = plot;
    const observer = new ResizeObserver(([entry]) => {
      plot.resize(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(element);

    return () => {
      observer.disconnect();
      plot.destroy();
      controller.current = null;
    };
  }, [history]);

  useEffect(() => restyle(style), [style]);
  useEffect(() => controller.current?.setPaused(paused), [paused]);
  useEffect(() => controller.current?.setVisible(visible), [visible]);
  useEffect(() => controller.current?.setSpan(spanS * 1e6), [spanS]);

  const missing = presented.filter((entry) => entry.missing).map((entry) => entry.name);
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
        {missing.length > 0 ? (
          <span
            data-missing
            title={missing.join(', ')}
            className="rounded-md border bg-card px-2 py-0.5 font-mono text-xs text-muted-foreground"
          >
            {missing.length} missing
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
        {paused ? (
          <Button
            variant="outline"
            size="xs"
            className="pointer-events-auto"
            aria-label="Back to live"
            onClick={() => shell.getState().setPaused(window.id, false)}
          >
            <Undo2Icon />
            Live
          </Button>
        ) : null}
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
        data-paused={paused}
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
